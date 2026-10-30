/**
 * The host: the program side of the terminal. It observes the `shell` View
 * for the person typing and draws it with Ink, each part a component that
 * redraws on its own when what it read changes. Lines typed, piped or given
 * run as commands. It holds nothing else: the screen is the Views over data.
 *
 * ```ts
 * await terminal({ runtime, me: "ana", banner: "my app" });
 * ```
 */
import process from "node:process";
import { createInterface } from "node:readline";
import type { Writable } from "node:stream";
import { render } from "ink";
import type { Actor, Observed, Runtime, Stats } from "../../runtime/mod.ts";
import {
  type Command,
  type Commands,
  dim,
  red,
  type ShellState,
  type Terminal,
} from "./contract.ts";
import { TypingContext } from "./composer.tsx";
import { message, Part } from "./part.tsx";
import { ScrollbackRoot } from "./scrollback.tsx";

export type TerminalOptions = {
  runtime: Runtime;
  /** Who is typing: the viewer every View renders for. */
  me: string;
  /**
   * Who they are to the runtime: every call, read and View is theirs, and
   * the access rules apply. Without one, the system acts (a tool for one).
   */
  actor?: Actor;
  /** The space they work in (new conversations go there). */
  space?: string;
  /** Printed first. */
  banner?: string;
  /** The terminal's whole screen (its alternate screen) instead of a scrolling log. */
  screen?: boolean;
  /** The app's own commands, beside the plugins' (and over them, by name). */
  commands?: Commands;
  /** Printed after each line: how long it took and what the runtime did meanwhile. */
  footer?(line: { command?: string; ms: number; before: Stats; after: Stats }): string | undefined;
  /** Lines to run instead of what's typed (scripts, tests); it ends after them. */
  input?: AsyncIterable<string>;
  /** Where to draw (standard output by default). */
  stdout?: Writable & { columns?: number; isTTY?: boolean };
  /**
   * Who `/as <name>` makes the one typing: lets one terminal play several
   * people, to try things out. Without it, there's no `/as`.
   */
  become?(name: string): Promise<{ actor: Actor; space?: string }>;
};

/** Who is typing, to the runtime and on the screen. */
type Who = { me: string; actor?: Actor; space?: string };

/** Runs the terminal until its input ends, `/quit`, or Ctrl+C. */
export async function terminal(options: TerminalOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const interactive = !options.input && Boolean(process.stdin.isTTY && stdout.isTTY);
  // Lines from a script, or piped in, read across everyone who types them.
  const lines = interactive ? undefined : (options.input ??
    createInterface({ input: process.stdin }))[Symbol.asyncIterator]();
  let who: Who | undefined = {
    me: options.me,
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.space ? { space: options.space } : {}),
  };
  for (let first = true; who; first = false) {
    who = await session(options, who, { first, interactive, lines });
  }
}

/** One person at the terminal, until they leave (undefined) or `/as` makes someone else type. */
async function session(
  options: TerminalOptions,
  { me, actor, space }: Who,
  { first, interactive, lines }: {
    first: boolean;
    interactive: boolean;
    lines?: AsyncIterator<string>;
  },
): Promise<Who | undefined> {
  const as = actor ? { actor } : {};
  // The runtime as this person: everything commands do is theirs.
  const runtime: Runtime = actor
    ? {
      ...options.runtime,
      call: (action, input, o = {}) => options.runtime.call(action, input, { ...o, actor }),
      query: (name, params, o = {}) => options.runtime.query(name, params, { ...o, actor }),
      emit: (type, data, o = {}) => options.runtime.emit(type, data, { ...o, actor }),
    }
    : options.runtime;
  const stdout = options.stdout ?? process.stdout;

  const print = (text: string) => runtime.call("shell.print", { person: me, text }).then(() => {});
  const term: Terminal = {
    me,
    runtime,
    state: () => runtime.query<ShellState>("shell.mine", { person: me }),
    set: async (fields) => void await runtime.call("shell.set", { person: me, ...fields }),
    show: async (kind, item, hints) => {
      for (const one of Array.isArray(item) ? item : [item]) {
        await runtime.call("shell.print", {
          person: me,
          kind,
          item: one,
          ...(hints ? { hints } : {}),
        });
      }
    },
    print,
  };

  let quit = (_next?: Who) => {};
  const quitting = new Promise<Who | undefined>((resolve) => quit = resolve);

  const commands: Commands = {
    ...(runtime.describe().resources.commands as Commands | undefined),
    "/help": { description: "These commands", run: () => print(help(commands)) },
    ...(options.become
      ? {
        "/as": {
          description: "Type as someone else (to try things out as several people)",
          usage: "<name>",
          async run(name: string) {
            if (!name) return await print(dim("Usage: /as <name>"));
            const next = await options.become!(name);
            quit({ me: name, ...next });
          },
        },
      }
      : {}),
    ...options.commands,
  };

  // Whether a line is running, for the composer.
  let busy = false;
  const waiting = new Set<() => void>();
  const working = (now: boolean) => {
    busy = now;
    for (const listener of waiting) listener();
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (text === "/quit") return quit();
    const [name, ...rest] = text.split(" ");
    const isCommand = text.startsWith("/");
    const command: Command | undefined = isCommand ? commands[name] : commands["*"];
    working(true);
    const before = runtime.stats();
    const started = performance.now();
    try {
      // What you typed stays above what it printed; a message shows as itself.
      if (isCommand) await print(dim(`${me} › ${text}`));
      if (!command) {
        await print(
          dim(isCommand ? "Unknown command; /help lists them." : "Nothing takes text here."),
        );
      } else await command.run(isCommand ? rest.join(" ") : text, term);
    } catch (error) {
      await print(red(`✗ ${message(error)}`)).catch(() => {});
    }
    await runtime.idle();
    const footer = options.footer?.({
      ...(isCommand ? { command: name } : {}),
      ms: performance.now() - started,
      before,
      after: runtime.stats(),
    });
    if (footer) await print(dim(footer));
    await runtime.idle();
    working(false);
  };

  // Where they work: kept, unless they've moved elsewhere already.
  const state = await runtime.query<ShellState>("shell.mine", { person: me });
  if (space && !state.space) await runtime.call("shell.set", { person: me, space });
  const screen = runtime.observe("terminal", "shell", { person: me }, {
    ...as,
    viewer: { name: me, kind: "person" },
    // What was printed before they sat down is already on the screen.
    hints: {
      since: new Date().toISOString(),
      ...(first && options.banner ? { banner: options.banner } : {}),
    },
    // Each part a component of its own, redrawn when its output changes.
    part: (part: Observed, key: string) => <Part key={key} part={part} />,
  });
  await screen.ready;
  const app = render(
    <TypingContext
      value={{
        submit,
        busy: {
          get: () => busy,
          subscribe: (listener) => (waiting.add(listener), () => waiting.delete(listener)),
        },
        suggestions: [...Object.keys(commands).filter((name) => name !== "*"), "/quit"],
        keys: Object.fromEntries(
          Object.values(commands).flatMap((c) =>
            c.key ? [[c.key, () => void Promise.resolve(c.run("", term)).catch(() => {})]] : []
          ),
        ),
        interactive,
      }}
    >
      <ScrollbackRoot>
        <Part part={screen} />
      </ScrollbackRoot>
    </TypingContext>,
    {
      stdout: stdout as never,
      interactive,
      patchConsole: interactive,
      incrementalRendering: true,
      ...(options.screen && interactive ? { alternateScreen: true } : {}),
    },
  );

  let next: Who | undefined;
  void quitting.then((who) => next = who);
  try {
    if (interactive) await Promise.race([quitting, app.waitUntilExit()]);
    else {
      // Each line runs once the last is done; `/as` hands the rest to someone else.
      for (let line = await lines!.next(); !line.done; line = await lines!.next()) {
        if (line.value.trim() === "/quit") break;
        await submit(line.value);
        await Promise.resolve();
        if (next) break;
      }
    }
    await runtime.idle();
    await app.waitUntilRenderFlush();
  } finally {
    // Handing over: their prompt goes with them; what's done stays in the scrollback.
    if (next && interactive) app.clear();
    app.unmount();
    await app.waitUntilExit().catch(() => {});
    screen.close();
  }
  return next;
}

/** The commands, one per line: what follows each, and what it does. */
function help(commands: Commands): string {
  const all = Object.entries(commands).filter(([name]) => name !== "*")
    .sort(([a], [b]) => a < b ? -1 : 1);
  const width = Math.max(...all.map(([n, c]) => `${n} ${c.usage ?? ""}`.trim().length), 5);
  return [
    ...all.map(([name, c]) =>
      `${`${name} ${c.usage ?? ""}`.trim().padEnd(width)}  ${dim(c.description)}${
        c.key ? dim(` (${c.key === "escape" ? "Esc" : c.key})`) : ""
      }`
    ),
    ...(commands["*"] ? [`${"text".padEnd(width)}  ${dim(commands["*"].description)}`] : []),
    `${"/quit".padEnd(width)}  ${dim("Leave")}`,
  ].join("\n");
}
