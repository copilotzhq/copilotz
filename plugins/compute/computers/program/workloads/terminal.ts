/**
 * Shells, one per space's folder and who (sandbox-lite's terminal). A
 * command answers within about a second with what it wrote, running or done;
 * an empty `stdin` polls for more, other `stdin` goes to the command running,
 * and `interrupt` stops it (SIGINT, then SIGKILL after a grace). Each shell
 * keeps its working directory, environment and history while it lives, and
 * goes after 30 minutes unused.
 *
 * A shell is a bash reading script paths, one per line, and sourcing each:
 * commands can be megabytes, and a command reading stdin reads what's sent
 * to it, not the next command. After each, it prints a marker on stdout (with
 * its working directory) and on stderr, so both are drained before it's done.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { setInterval } from "node:timers";
import type { TerminalInput, TerminalResult } from "../../shared/workloads.ts";
import { fail } from "./answer.ts";
import type { Spaces } from "./spaces.ts";
import { childEnv, exitCode, signalGroup } from "./processes.ts";

export type ShellLimits = {
  /** The longest an answer waits for its command (a command done sooner answers at once). */
  yieldMs?: number;
  /** A command with no input or output this long times out. */
  idleMs?: number;
  /** A command running this long times out. */
  runtimeMs?: number;
  /** Output kept per stream between answers; older output is dropped (and said so). */
  outputChars?: number;
  /** After a signal, how long until SIGKILL. */
  killGraceMs?: number;
  /** Finished commands kept for polls, and for how long. */
  retainedCommands?: number;
  retentionMs?: number;
  /** A shell unused this long goes. */
  shellIdleMs?: number;
};

type Shell = {
  key: string;
  /** Its space's folder (a real path). */
  folder: string;
  child: ChildProcess;
  /** Marks this shell's markers. */
  token: string;
  /** Where its command scripts go, outside the space's folder. */
  directory: string;
  active?: Command;
  dead: boolean;
  /** Its working directory after the last command. */
  cwd: string;
  lastUsed: number;
  drained: Promise<void>;
};

type Command = {
  id: string;
  owner: string;
  shell: Shell;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  running: boolean;
  timedOut: boolean;
  interrupted?: boolean;
  lastActivity: number;
  started: number;
  ended?: number;
  markers: number;
  script: string;
  timer?: ReturnType<typeof setInterval>;
  killTimer?: ReturnType<typeof setTimeout>;
  waiters: Set<() => void>;
};

/** Single quotes for bash. */
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** The loop a shell runs: source each script it's sent, then mark it done. */
function driver(directory: string, token: string) {
  return [
    // Signals stop the command, not the shell (SIGKILL, after a grace, stops both).
    "trap ':' INT TERM",
    "while IFS= read -r __copilotz_script; do",
    `  case "$__copilotz_script" in ${quote(directory)}/*.sh) ;; *) continue ;; esac`,
    "  __copilotz_id=${__copilotz_script##*/}; __copilotz_id=${__copilotz_id%.sh}",
    '  if source "$__copilotz_script"; then __copilotz_code=0; else __copilotz_code=$?; fi',
    "  set +e +u; set +o pipefail",
    `  builtin printf '\\036%s:%s:%d:%s\\037' ${token} "$__copilotz_id" "$__copilotz_code" "$PWD"`,
    `  builtin printf '\\036%s:%s:%d:\\037' ${token} "$__copilotz_id" "$__copilotz_code" >&2`,
    "done",
  ].join("\n");
}

/** Where a shell is, relative to its space's folder (absolute when it's outside it). */
function where(folder: string, cwd: string) {
  const path = relative(folder, cwd);
  if (!path) return ".";
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ? cwd : path;
}

/** The shells of every space on this computer. */
export function createShells(spaces: Spaces, limits: ShellLimits = {}) {
  const yieldMs = limits.yieldMs ?? 1000;
  const idleMs = limits.idleMs ?? 5 * 60_000;
  const runtimeMs = limits.runtimeMs ?? 10 * 60_000;
  const outputChars = limits.outputChars ?? 64 * 1024;
  const killGraceMs = limits.killGraceMs ?? 1000;
  const retainedCommands = limits.retainedCommands ?? 32;
  const retentionMs = limits.retentionMs ?? 10 * 60_000;
  const shellIdleMs = limits.shellIdleMs ?? 30 * 60_000;
  const commands = new Map<string, Command>();
  const shells = new Map<string, Shell>();
  const opening = new Map<string, Promise<Shell>>();
  const starting = new Set<string>();
  let closed = false;

  function finish(command: Command, code: number) {
    if (!command.running) return;
    command.running = false;
    command.exitCode = code;
    command.ended = Date.now();
    clearInterval(command.timer);
    clearTimeout(command.killTimer);
    if (command.shell.active === command) command.shell.active = undefined;
    command.shell.lastUsed = Date.now();
    void rm(command.script, { force: true }).catch(() => {});
    for (const wake of command.waiters) wake();
    prune();
  }

  /** Finished commands go after a while, or when too many are kept. */
  function prune() {
    const done = [...commands.values()].filter((c) => !c.running);
    let kept = done.length;
    for (const command of done) {
      if (Date.now() - command.ended! > retentionMs || kept > retainedCommands) {
        commands.delete(command.id);
        kept--;
      }
    }
  }

  function append(shell: Shell, stream: "stdout" | "stderr", text: string) {
    const command = shell.active;
    if (!command || !text) return;
    command.lastActivity = Date.now();
    const combined = command[stream] + text;
    if (combined.length > outputChars) command[`${stream}Truncated`] = true;
    command[stream] = combined.slice(-outputChars);
  }

  /** Reads a stream, taking out this shell's markers. */
  function pump(shell: Shell, stream: "stdout" | "stderr") {
    const prefix = `\x1e${shell.token}:`;
    let pending = "";
    const readable = shell.child[stream]!;
    readable.setEncoding("utf8");
    readable.on("data", (chunk: string) => {
      pending += chunk;
      while (pending) {
        const start = pending.indexOf(prefix);
        if (start < 0) {
          // Keep what may be the start of a marker.
          let keep = Math.min(prefix.length - 1, pending.length);
          while (keep && !pending.endsWith(prefix.slice(0, keep))) keep--;
          append(shell, stream, pending.slice(0, pending.length - keep));
          pending = pending.slice(pending.length - keep);
          break;
        }
        append(shell, stream, pending.slice(0, start));
        pending = pending.slice(start);
        const end = pending.indexOf("\x1f", prefix.length);
        if (end < 0) break;
        const [id, code, ...cwd] = pending.slice(prefix.length, end).split(":");
        pending = pending.slice(end + 1);
        const command = shell.active;
        if (command?.id !== id) continue;
        if (stream === "stdout" && cwd.join(":")) shell.cwd = cwd.join(":");
        if (++command.markers === 2) finish(command, Number(code));
      }
    });
    readable.on("end", () => append(shell, stream, pending));
    readable.on("error", () => {});
  }

  async function open(key: string, folder: string): Promise<Shell> {
    const directory = await mkdtemp(join(tmpdir(), "copilotz-shell-"));
    const token = randomBytes(8).toString("hex");
    const child = spawn("bash", ["--noprofile", "--norc", "-c", driver(directory, token)], {
      cwd: folder,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group: signals reach everything a command starts.
      detached: true,
    });
    const shell: Shell = {
      key,
      folder,
      child,
      token,
      directory,
      dead: false,
      cwd: folder,
      lastUsed: Date.now(),
      drained: Promise.resolve(),
    };
    child.stdin!.on("error", () => {});
    pump(shell, "stdout");
    pump(shell, "stderr");
    shell.drained = new Promise<void>((resolve) => {
      let done = false;
      const end = (code: number) => {
        if (done) return;
        done = true;
        shell.dead = true;
        if (shell.active) finish(shell.active, code);
        if (shells.get(key) === shell) shells.delete(key);
        void rm(directory, { recursive: true, force: true }).catch(() => {}).then(() => resolve());
      };
      child.on("error", (error) => {
        append(shell, "stderr", `${error.message}\n`);
        end(127);
      });
      // What a command left running keeps the pipes open: it goes with its shell.
      child.on("exit", () => {
        shell.dead = true;
        signalGroup(child.pid, "SIGKILL");
      });
      child.on("close", (code, signal) => end(exitCode(code, signal)));
    });
    return shell;
  }

  /** This key's shell, opened if it has none (or its last one ended). */
  async function shellOf(key: string, folder: string) {
    const shell = shells.get(key);
    if (shell && !shell.dead) return shell;
    let pending = opening.get(key);
    if (!pending) {
      pending = open(key, folder).then((value) => {
        shells.set(key, value);
        return value;
      }).finally(() => opening.delete(key));
      opening.set(key, pending);
    }
    return await pending;
  }

  /** Stops a command: SIGINT (an interrupt) or SIGTERM (a timeout), then SIGKILL. */
  function stop(command: Command, timeout: boolean) {
    if (!command.running) return false;
    if (timeout) command.timedOut = true;
    const pid = command.shell.child.pid;
    const sent = signalGroup(pid, timeout ? "SIGTERM" : "SIGINT");
    if (!timeout && sent) command.interrupted = true;
    // If the shell outlived it, its next command isn't killed.
    command.killTimer ??= setTimeout(() => {
      if (command.running && command.shell.active === command) signalGroup(pid, "SIGKILL");
    }, killGraceMs);
    return sent;
  }

  /** Until the command is done, or the answer is due. */
  async function wait(command: Command) {
    if (!command.running) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        command.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, yieldMs);
      command.waiters.add(done);
      if (!command.running) done();
    });
  }

  /** Ends a shell: no more commands, its command stopped, SIGKILL after the grace. */
  async function end(shell: Shell) {
    shell.child.stdin?.end();
    signalGroup(shell.child.pid, "SIGTERM");
    const timer = setTimeout(() => signalGroup(shell.child.pid, "SIGKILL"), killGraceMs);
    await shell.drained;
    clearTimeout(timer);
  }

  // Shells unused for a while go.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, shell] of shells) {
      if (!shell.active && !shell.dead && now - shell.lastUsed >= shellIdleMs) {
        shells.delete(key);
        void end(shell);
      }
    }
  }, Math.max(10, Math.min(60_000, shellIdleMs / 2)));
  sweeper.unref();

  const empty = (commandId: string, folder: string, shell?: Shell): TerminalResult => ({
    state: "idle",
    commandId,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: null,
    timedOut: false,
    interrupted: false,
    durationMs: 0,
    cwd: where(folder, shell && !shell.dead ? shell.cwd : folder),
  });

  return {
    async submit(input: TerminalInput): Promise<TerminalResult> {
      const started = Date.now();
      if (closed) fail("The computer is stopping", "stopping");
      const key = spaces.key(input.scope);
      const folder = await spaces.folder(input.scope);
      if (input.operation !== undefined && input.operation !== "interrupt") {
        fail(`Unknown operation "${input.operation}"`);
      }
      if (input.operation === "interrupt" && !input.commandId) fail("interrupt needs a commandId");
      if (!input.operation && typeof input.stdin !== "string") fail("stdin is required");
      prune();
      const current = shells.get(key);
      let command: Command | undefined;
      if (input.commandId) {
        command = commands.get(input.commandId);
        if (!command || command.owner !== key) {
          if (input.operation === "interrupt") return empty(input.commandId, folder, current);
          fail("Unknown or expired commandId", "not_found");
        }
        if (input.operation === "interrupt" && !command.running) {
          return empty(input.commandId, folder, command.shell);
        }
      } else if (current && !current.dead) {
        command = current.active;
      }
      if (!command) {
        if (!input.stdin) return empty(randomUUID(), folder, current);
        if (starting.has(key)) fail("This shell is starting a command", "busy");
        starting.add(key);
        let shell: Shell;
        try {
          shell = await shellOf(key, folder);
        } finally {
          starting.delete(key);
        }
        if (shell.active) fail("This shell is busy", "busy");
        if (closed) {
          void end(shell);
          fail("The computer is stopping", "stopping");
        }
        const id = randomUUID();
        command = {
          id,
          owner: key,
          shell,
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          exitCode: null,
          running: true,
          timedOut: false,
          started,
          lastActivity: started,
          markers: 0,
          script: join(shell.directory, `${id}.sh`),
          waiters: new Set(),
        };
        shell.active = command;
        shell.lastUsed = started;
        commands.set(id, command);
        try {
          await writeFile(command.script, input.stdin, { mode: 0o600 });
          shell.child.stdin!.write(`${command.script}\n`);
        } catch (error) {
          signalGroup(shell.child.pid, "SIGKILL");
          throw error;
        }
        const timed = command;
        timed.timer = setInterval(() => {
          const now = Date.now();
          if (now - timed.lastActivity >= idleMs || now - timed.started >= runtimeMs) {
            stop(timed, true);
          }
        }, Math.max(5, Math.min(1000, idleMs / 4, runtimeMs / 4)));
        timed.timer.unref();
      } else if (input.operation === "interrupt") {
        if (!stop(command, false)) command.interrupted = false;
      } else if (input.stdin) {
        if (!command.running) fail("That command has finished; stdin wasn't sent", "not_found");
        command.lastActivity = Date.now();
        command.shell.lastUsed = Date.now();
        command.shell.child.stdin!.write(input.stdin);
      }
      await wait(command);
      const result: TerminalResult = {
        state: command.running ? "running" : "idle",
        commandId: command.id,
        stdout: command.stdout,
        stderr: command.stderr,
        stdoutTruncated: command.stdoutTruncated,
        stderrTruncated: command.stderrTruncated,
        exitCode: command.running ? null : command.exitCode,
        timedOut: command.timedOut,
        ...(command.interrupted === undefined ? {} : { interrupted: command.interrupted }),
        durationMs: Date.now() - started,
        cwd: where(folder, command.shell.cwd),
      };
      command.stdout = command.stderr = "";
      command.stdoutTruncated = command.stderrTruncated = false;
      return result;
    },
    /** Every shell ends (the computer is stopping). */
    async stopAll() {
      closed = true;
      clearInterval(sweeper);
      await Promise.allSettled(opening.values());
      const all = new Set([...shells.values(), ...[...commands.values()].map((c) => c.shell)]);
      await Promise.all([...all].map((shell) => end(shell)));
      shells.clear();
      commands.clear();
    },
  };
}
