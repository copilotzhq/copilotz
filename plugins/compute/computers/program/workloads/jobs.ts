/**
 * Background jobs (sandbox-lite's process table): a command that outlives
 * the work that started it, in its own process group, with the last 256 KiB
 * of each stream kept. Jobs are whose started them in a space's folder: an
 * agent sees and stops only its own (its person's panel lists them all).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type {
  Job,
  JobsListInput,
  JobsLogs,
  JobsLogsInput,
  JobsStartInput,
  JobsStopInput,
} from "../../shared/workloads.ts";
import { fail } from "./answer.ts";
import { checkScope, type Spaces } from "./spaces.ts";
import { childEnv, exitCode, signalGroup } from "./processes.ts";

const KEPT = 256 * 1024;
/** Finished jobs kept per who and space, newest first. */
const FINISHED = 100;

type Entry = {
  job: Job;
  folder: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  /** Output was dropped (beyond what's kept). */
  dropped: boolean;
  exited: Promise<void>;
};

/** The jobs of every space on this computer. */
export function createJobs(spaces: Spaces, options: { stopGraceMs?: number } = {}) {
  const entries = new Map<string, Entry>();
  const stopGraceMs = options.stopGraceMs ?? 3000;
  let closed = false;

  /** A job of this scope's who, in its folder: another's isn't there to them. */
  function mine(scope: JobsStopInput["scope"], id: unknown): Entry {
    const { folder, who } = checkScope(scope);
    const entry = typeof id === "string" ? entries.get(id) : undefined;
    if (!entry || entry.folder !== folder || entry.job.who !== who) {
      fail(`No job ${String(id)}`, "not_found");
    }
    return entry;
  }

  /** Finished jobs beyond the most kept go, oldest first. */
  function prune(folder: string, who: string) {
    const done = [...entries.values()].filter((e) =>
      e.folder === folder && e.job.who === who && !e.job.running
    );
    for (const entry of done.slice(0, Math.max(0, done.length - FINISHED))) {
      entries.delete(entry.job.id);
    }
  }

  function keep(entry: Entry, stream: "stdout" | "stderr", text: string) {
    const combined = entry[stream] + text;
    if (combined.length > KEPT) entry.dropped = true;
    entry[stream] = combined.slice(-KEPT);
  }

  return {
    async start(input: JobsStartInput): Promise<Job> {
      if (closed) fail("The computer is stopping", "stopping");
      const { folder: name, who } = checkScope(input.scope);
      if (typeof input.command !== "string" || !input.command.trim()) fail("command is required");
      const cwd = await spaces.folder(input.scope);
      const id = `job-${randomBytes(6).toString("hex")}`;
      const child = spawn("bash", ["--noprofile", "--norc", "-c", input.command], {
        cwd,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        // Its own process group, so stopping it reaches everything it starts.
        detached: true,
      });
      const entry: Entry = {
        job: {
          id,
          who,
          name: typeof input.name === "string" && input.name ? input.name : id,
          command: input.command,
          pid: child.pid ?? null,
          running: true,
          exitCode: null,
          startedAt: new Date().toISOString(),
        },
        folder: name,
        child,
        stdout: "",
        stderr: "",
        dropped: false,
        exited: Promise.resolve(),
      };
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream]!.setEncoding("utf8");
        child[stream]!.on("data", (text: string) => keep(entry, stream, text));
        child[stream]!.on("error", () => {});
      }
      entry.exited = new Promise<void>((resolve) => {
        let done = false;
        const end = (code: number) => {
          if (done) return;
          done = true;
          entry.job = {
            ...entry.job,
            running: false,
            exitCode: code,
            endedAt: new Date().toISOString(),
          };
          prune(name, who);
          resolve();
        };
        child.on("error", (error) => {
          keep(entry, "stderr", `${error.message}\n`);
          end(127);
        });
        // What it left running holds the pipes open: it goes with it.
        child.on("exit", () => signalGroup(child.pid, "SIGKILL"));
        child.on("close", (code, signal) => end(exitCode(code, signal)));
      });
      entries.set(id, entry);
      return entry.job;
    },

    list(input: JobsListInput): Job[] {
      const { folder, who } = checkScope(input.scope);
      return [...entries.values()]
        .filter((e) => e.folder === folder && (input.all === true || e.job.who === who))
        .map((e) => e.job);
    },

    logs(input: JobsLogsInput): JobsLogs {
      const entry = mine(input.scope, input.id);
      const tail = typeof input.tail === "number" && input.tail >= 0 ? input.tail : undefined;
      const cut = (text: string) => tail === undefined ? text : tail === 0 ? "" : text.slice(-tail);
      const stdout = cut(entry.stdout);
      const stderr = cut(entry.stderr);
      return {
        job: entry.job,
        stdout,
        stderr,
        truncated: entry.dropped || stdout.length < entry.stdout.length ||
          stderr.length < entry.stderr.length,
      };
    },

    /** SIGTERM to its group, then SIGKILL after the grace; answers once it's ended. */
    async stop(input: JobsStopInput): Promise<Job> {
      const entry = mine(input.scope, input.id);
      if (!entry.job.running) return entry.job;
      signalGroup(entry.child.pid, "SIGTERM");
      const timer = setTimeout(() => signalGroup(entry.child.pid, "SIGKILL"), stopGraceMs);
      await entry.exited;
      clearTimeout(timer);
      return entry.job;
    },

    /** Every job stops (the computer is stopping). */
    async stopAll() {
      closed = true;
      await Promise.all([...entries.values()].map(async (entry) => {
        if (!entry.job.running) return;
        signalGroup(entry.child.pid, "SIGTERM");
        const timer = setTimeout(() => signalGroup(entry.child.pid, "SIGKILL"), 1000);
        await entry.exited;
        clearTimeout(timer);
      }));
    },
  };
}
