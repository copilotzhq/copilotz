/**
 * A person's plans on their own computers, as the web shows them, in plain
 * functions: the plans (each CLI, the words it's named with and its official
 * install), how one computer stands for one plan (signed in, installed,
 * missing, not checked, or shared with others' agents, so it can't be
 * used), which computer a sign-in goes to first, and a CLI's output and
 * links as they're safe to show.
 */
import type { Computer } from "../../collections/computer.ts";
import type { Desk } from "../../collections/desk.ts";
import type { EngineName, EngineSeen } from "../../shared/engines.ts";
import { say } from "./words.ts";

/** A plan: its engine (the CLI), its provider, and the command that installs the CLI. */
export type Plan = {
  engine: EngineName;
  provider: string;
  install: string;
  /** The words it's named with (`claudeTitle`, `claudePlan`, `claudeCli`, `claudeAbout`). */
  title: string;
  plan: string;
  cli: string;
  about: string;
};

const INSTALL: Record<EngineName, { provider: string; install: string }> = {
  claude: { provider: "claude-plan", install: "curl -fsSL https://claude.ai/install.sh | bash" },
  codex: { provider: "codex-plan", install: "npm i -g @openai/codex" },
  antigravity: {
    provider: "gemini-plan",
    install: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
};

/** The plans, in their order, named in the app's words. */
export const plans = (): Plan[] => [
  {
    engine: "claude",
    ...INSTALL.claude,
    title: say("claudeTitle"),
    plan: say("claudePlan"),
    cli: say("claudeCli"),
    about: say("claudeAbout"),
  },
  {
    engine: "codex",
    ...INSTALL.codex,
    title: say("codexTitle"),
    plan: say("codexPlan"),
    cli: say("codexCli"),
    about: say("codexAbout"),
  },
  {
    engine: "antigravity",
    ...INSTALL.antigravity,
    title: say("antigravityTitle"),
    plan: say("antigravityPlan"),
    cli: say("antigravityCli"),
    about: say("antigravityAbout"),
  },
];

export const planOf = (engine: string | undefined): Plan | undefined =>
  plans().find((p) => p.engine === engine);

/** A space a computer of theirs is shared into, where others' agents work on it as them. */
export type SharedIn = { _id: string; name: string };

/** One of the person's computers, as the plans need it. */
export type Machine = {
  computer: Computer;
  name: string;
  /** A cloud computer's (a kind's), which wakes when it's asked: its kind's View, its icon. */
  kind?: { view: string; icon?: string };
  /** Where others' agents work on it as its owner (it can't run their plan); `true`: somewhere they don't reach. */
  shared: SharedIn[] | true | false;
};

/** How one computer stands for one plan. */
export type Standing =
  | { state: "shared" }
  | { state: "signedIn"; account?: string; version?: string; at?: string }
  | { state: "installed"; version?: string; at?: string }
  | { state: "missing"; at?: string }
  | { state: "unchecked" };

/** Whether others' agents work on it as its owner, so their plan can't run there. */
export const isShared = (m: Machine): boolean =>
  Array.isArray(m.shared) ? m.shared.length > 0 : m.shared;

export function standingOf(machine: Machine, engine: EngineName): Standing {
  if (isShared(machine)) return { state: "shared" };
  const seen = (machine.computer.engines as Partial<Record<EngineName, EngineSeen>> | undefined)
    ?.[engine];
  if (!seen) return { state: "unchecked" };
  const at = seen.at ? { at: seen.at } : {};
  if (seen.signedIn) {
    return {
      state: "signedIn",
      ...(seen.account ? { account: seen.account } : {}),
      ...(seen.version ? { version: seen.version } : {}),
      ...at,
    };
  }
  if (seen.installed) {
    return { state: "installed", ...(seen.version ? { version: seen.version } : {}), ...at };
  }
  return { state: "missing", ...at };
}

/** Whether it can be asked now: online, or a cloud computer, which wakes. */
export const reachable = (m: Machine) => m.computer.online || !!m.kind;

/** Whether a sign-in can start there now: reachable, not shared, and its CLI there (or not said). */
export function startable(m: Machine, engine: EngineName): boolean {
  const { state } = standingOf(m, engine);
  return reachable(m) && state !== "shared" && state !== "missing";
}

/**
 * The computers a sign-in may go to, best first: not shared; reachable
 * (online before asleep); its CLI installed and not signed in, then not
 * said, then signed in already (to sign in again), then missing; then the
 * most recently seen.
 */
export function ranked(machines: Machine[], engine: EngineName): Machine[] {
  const STATE: Record<Standing["state"], number> = {
    installed: 0,
    unchecked: 1,
    signedIn: 2,
    missing: 3,
    shared: 4,
  };
  const score = (m: Machine) =>
    (isShared(m) ? 100 : 0) + (m.computer.online ? 0 : m.kind ? 10 : 20) +
    STATE[standingOf(m, engine).state];
  return [...machines].sort((a, b) =>
    score(a) - score(b) || (b.computer.seen ?? "").localeCompare(a.computer.seen ?? "")
  );
}

/**
 * Where "Sign in" goes at once, with nothing to choose: the one computer a
 * sign-in can start on now, when there's only one and its CLI is there.
 */
export function straightTo(machines: Machine[], engine: EngineName): Machine | undefined {
  const ready = machines.filter((m) => startable(m, engine));
  if (ready.length !== 1) return undefined;
  const [one] = ready;
  return standingOf(one, engine).state === "unchecked" ? undefined : one;
}

/** The computers a plan is signed in on (shared ones can't count). */
export const signedOn = (machines: Machine[], engine: EngineName): Machine[] =>
  machines.filter((m) => standingOf(m, engine).state === "signedIn");

/**
 * Where others' agents work on a computer as its owner, from its desks:
 * those in a space other than a Personal one, where agents answer to
 * whoever they work for (see shared/engines.ts).
 */
export function sharedIn(
  desks: Desk[],
  spaces: { _id: string; name: string; kind?: string }[],
): SharedIn[] {
  return desks.flatMap((desk) => {
    if (desk.answers !== "asker") return [];
    const space = spaces.find((s) => s._id === desk.in);
    if (!space || space.kind === "personal") return [];
    return [{ _id: space._id, name: space.name }];
  });
}

/** Names as a sentence lists them: "Acme", "Acme and Design", "Acme, Design and Ops". */
export function listed(names: string[]): string {
  if (names.length < 2) return names.join("");
  if (names.length === 2) return say("listPair", { first: names[0], second: names[1] });
  return say("listMore", { rest: names.slice(0, -1).join(", "), last: names.at(-1)! });
}

/**
 * A CLI's output as it reads on a page: no colours or cursor moves, a line
 * redrawn in place kept as its last state, no runs of blank lines.
 */
export function plainOutput(text: string): string {
  return text
    // OSC (titles, links) and CSI (colours, cursor) sequences, and other escapes.
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/\x1b[@-_]/g, "")
    .split("\n")
    .map((line) => line.split("\r").filter(Boolean).at(-1) ?? "")
    .join("\n")
    .replace(/[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** A sign-in link, only when it's a web address (never `javascript:` or a file). */
export function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A code the CLI shows for the person to type on the sign-in page (a device's
 * sign-in: "enter ABCD-EFGH at …"), when it shows one.
 */
export function shownCode(output: string): string | undefined {
  const said = /\b(?:code|enter)\b[^\n]{0,60}\n?[^\n]{0,40}?\b([A-Z0-9]{3,5}(?:-[A-Z0-9]{3,5})+)\b/
    .exec(output);
  return said?.[1];
}

/** Whether what a CLI said asks for a code to be pasted back to it (not one it shows). */
export const asksForCode = (output: string): boolean =>
  !shownCode(output) &&
  /\b(paste|enter|input)\b[^\n]{0,40}\b(code|token)\b|\b(code|token)\b[^\n]{0,20}:\s*$/im.test(
    output,
  );

/** What a sign-in answers each time it's asked (`computer.engine.login`, shared/workloads.ts). */
export type LoginStep = {
  state: "running" | "done";
  output: string;
  signedIn: boolean;
  url?: string;
};

/** What a sign-in under way says: each answer, or why it couldn't go on. */
export type LoginEvent = { step: LoginStep } | { error: unknown };

/**
 * Signs `engine` in on `computer` (`computer.engine.login`): asks again every
 * `every` ms while it runs, one call at a time, each answer to `on`, until
 * it's done or fails. `send` hands the CLI what the person typed (on the
 * next call, at once when none is under way); `stop` ends it there too;
 * `leave` stops asking without telling it (it's done, or gone).
 */
export function signingIn(
  { call, computer, engine, on, every = 1000 }: {
    call<R = unknown>(action: string, input?: unknown): Promise<R>;
    computer: string;
    engine: EngineName;
    on(event: LoginEvent): void;
    every?: number;
  },
): { send(text: string): void; stop(): void; leave(): void } {
  let over = false;
  let flying = false;
  let typed: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async () => {
    if (over) return;
    clearTimeout(timer);
    flying = true;
    const input = typed;
    typed = undefined;
    try {
      const step = await call<LoginStep>("computer.engine.login", {
        computer,
        engine,
        ...(input !== undefined ? { input } : {}),
      });
      flying = false;
      if (over) return;
      if (step.state === "done") over = true;
      on({ step });
      if (!over) timer = setTimeout(() => void ask(), typed !== undefined ? 0 : every);
    } catch (error) {
      flying = false;
      if (over) return;
      over = true;
      on({ error });
    }
  };
  void ask();
  return {
    send(text) {
      typed = text;
      if (!flying && !over) void ask();
    },
    stop() {
      if (over) return;
      over = true;
      clearTimeout(timer);
      void call("computer.engine.login", { computer, engine, stop: true }).catch(() => {});
    },
    leave() {
      over = true;
      clearTimeout(timer);
    },
  };
}
