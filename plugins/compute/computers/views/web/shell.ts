/**
 * The person's own shell on their computer, in a space's folder, for the
 * web's terminal: a line at a time, over `computer.work`'s `terminal`
 * (sandbox-lite's contract, see shared/workloads.ts). A line starts a
 * command, which answers within about a second with what it wrote so far;
 * while it's `running`, an empty `stdin` with its `commandId` asks for more,
 * a line typed goes to it as its input, and Ctrl+C interrupts it. Each
 * answer carries only what's new, and the shell's working directory after
 * it (`cwd`, relative to the space's folder), which the prompt shows.
 *
 * Opening it asks once with an empty `stdin`: that runs nothing, says where
 * the shell is, and picks up a command still running from before (a reload,
 * another tab), whose output then goes on coming.
 */
import type { TerminalOutput, TerminalSession } from "../../../../../hosts/web/mod.ts";
import type { TerminalInput, TerminalResult } from "../../shared/workloads.ts";

/** Asks the shell: `computer.work` with work `terminal` and this input. */
export type Ask = (input: Omit<TerminalInput, "scope">) => Promise<TerminalResult>;

export type ShellOptions = {
  /** The space's folder, which the prompt starts from. */
  folder: string;
  /** Waits between polls that answered at once (a test's clock may be its own). */
  wait?: (ms: number) => Promise<void>;
};

/** The least time between polls, so a command that writes a lot isn't asked in a tight loop. */
const GAP = 200;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Where the shell is, as its prompt says: the folder, and the path in it. */
export function where(folder: string, cwd: string): string {
  if (!cwd || cwd === ".") return folder;
  // Outside the space's folder, the program says where in full.
  return cwd.startsWith("/") ? cwd : `${folder}/${cwd}`;
}

/** How a command ended, when it's worth saying: its exit code, a timeout, an interrupt. */
export function ending(result: TerminalResult): string | undefined {
  const notes = [
    result.interrupted ? "stopped" : undefined,
    result.timedOut ? "timed out" : undefined,
    result.exitCode !== null && result.exitCode !== 0 && !result.interrupted
      ? `exit ${result.exitCode}`
      : undefined,
    result.stdoutTruncated || result.stderrTruncated ? "some output was left out" : undefined,
  ].filter(Boolean);
  return notes.length ? notes.join(" · ") : undefined;
}

export function shellSession(ask: Ask, options: ShellOptions): TerminalSession & {
  /** The working directory, as the computer said it last. */
  cwd(): string;
  /** The command running, if one is. */
  running(): string | undefined;
} {
  const wait = options.wait ?? sleep;
  let cwd = ".";
  let command: string | undefined;
  /** The command just started, once its first answer says it runs: what's typed before then waits for it. */
  let starting: Promise<string | undefined> = Promise.resolve(undefined);
  const current = async () => command ?? await starting;

  /** Writes what an answer brought, and keeps where the shell is. */
  const show = (result: TerminalResult, out: TerminalOutput) => {
    if (result.cwd) cwd = result.cwd;
    if (result.stdout) out.write(result.stdout);
    if (result.stderr) out.error(result.stderr);
  };

  /** Follows a command until it's done (or the terminal goes), as answers come. */
  const follow = async (first: TerminalResult, out: TerminalOutput) => {
    let result = first;
    show(result, out);
    while (result.state === "running" && !out.signal.aborted) {
      command = result.commandId;
      const asked = Date.now();
      result = await ask({ stdin: "", commandId: result.commandId });
      if (out.signal.aborted) return;
      show(result, out);
      const took = Date.now() - asked;
      if (result.state === "running" && took < GAP) await wait(GAP - took);
    }
    command = undefined;
    starting = Promise.resolve(undefined);
    const said = ending(result);
    if (said) out.note(said);
  };

  return {
    prompt: () => where(options.folder, cwd),
    cwd: () => cwd,
    running: () => command,
    start: async (out) => {
      const first = await ask({ stdin: "" });
      if (first.state !== "running") return void (first.cwd && (cwd = first.cwd));
      out.note("Still running from before; Ctrl+C stops it.");
      await follow(first, out);
    },
    run: async (line, out) => {
      const first = ask({ stdin: line });
      starting = first.then(
        (r) => r.state === "running" ? r.commandId : undefined,
        () => undefined,
      );
      await follow(await first, out);
    },
    input: async (line, out) => {
      const id = await current();
      if (id) show(await ask({ stdin: `${line}\n`, commandId: id }), out);
    },
    interrupt: async (out) => {
      const id = await current();
      if (id) show(await ask({ operation: "interrupt", commandId: id }), out);
    },
  };
}
