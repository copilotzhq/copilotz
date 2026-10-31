/**
 * Background jobs (sandbox-lite's process table): a command that outlives
 * the work that started it, in its own process group, with the last 256 KiB
 * of each stream kept. Jobs are whose started them in a space's folder: an
 * agent sees and stops only its own (its person's panel lists them all).
 *
 * A job may say the port it serves (for previews); listed or read, a running
 * one says the ports its process tree listens on now (ports.ts). A job that's
 * kept (`keep`: a server, say) is written to the computer's list of kept jobs
 * (`kept`: `.copilotz/jobs.json` under its root), and started again when the
 * computer starts (a cloud computer's wake): the list is what was running
 * when it stopped. One that ends otherwise (stopped by whose it is, or on its
 * own) leaves the list.
 *
 * A job runs with the environment variables it's given (`env`: its space's,
 * and its caller's) over the computer's own; a kept job's are kept with it
 * (the list is readable only by the computer's user), so it starts again
 * with them.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Job,
  JobsListInput,
  JobsLogs,
  JobsLogsInput,
  JobsStartInput,
  JobsStopInput,
  Scope,
} from "../../shared/workloads.ts";
import { fail } from "./answer.ts";
import { portsOf } from "./ports.ts";
import { checkScope, type Spaces } from "./spaces.ts";
import { childEnv, exitCode, givenEnv, OWN, signalGroup } from "./processes.ts";
import { commandArgs, newlines, type Shell } from "./shell.ts";

const KEPT = 256 * 1024;
/** Finished jobs kept per who and space, newest first. */
const FINISHED = 100;

/** A job the computer keeps running, as its list has it. */
export type KeptJob = {
  folder: string;
  who: string;
  name: string;
  command: string;
  port?: number;
  env?: Record<string, string>;
};

type Entry = {
  job: Job;
  folder: string;
  child: ChildProcess;
  stdout: string;
  stderr: string;
  /** Output was dropped (beyond what's kept). */
  dropped: boolean;
  exited: Promise<void>;
  /** Its place in the list of kept jobs, while it's there. */
  kept?: KeptJob;
};

export type JobsOptions = {
  /** How long a job gets to stop after SIGTERM. */
  stopGraceMs?: number;
  /** Where the list of kept jobs is (none: jobs aren't kept). */
  kept?: string;
  /** Where what goes wrong with kept jobs is said. */
  log?: (line: string) => void;
};

/** A port, as a job says it serves one. */
const isPort = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536;

/** A kept job's environment variables, as its list has them (names to text), if any. */
function envOf(env: unknown): Record<string, string> | undefined {
  if (!env || typeof env !== "object" || Array.isArray(env)) return undefined;
  const entries = Object.entries(env).filter((e): e is [string, string] =>
    typeof e[1] === "string"
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** The list of kept jobs at `path`, as far as it's readable: none when it isn't there. */
async function readKept(path: string): Promise<KeptJob[]> {
  let list: unknown;
  try {
    list = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return [];
    throw error;
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((kept) =>
    typeof kept?.folder === "string" && typeof kept.who === "string" &&
      typeof kept.name === "string" && typeof kept.command === "string"
      ? [{
        folder: kept.folder,
        who: kept.who,
        name: kept.name,
        command: kept.command,
        ...(isPort(kept.port) ? { port: kept.port } : {}),
        ...(envOf(kept.env) ? { env: envOf(kept.env) } : {}),
      }]
      : []
  );
}

/** Writes the list of kept jobs whole (a temporary file renamed over it), readable only by its user. */
async function writeKept(path: string, list: KeptJob[]) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(list, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** The jobs of every space on this computer, each a command in its `shell`. */
export function createJobs(spaces: Spaces, shell: Shell, options: JobsOptions = {}) {
  const entries = new Map<string, Entry>();
  const stopGraceMs = options.stopGraceMs ?? 3000;
  const log = options.log ?? (() => {});
  /** The jobs kept, in the order they started. */
  const keeping = new Set<KeptJob>();
  let saved: Promise<void> = Promise.resolve();
  let closed = false;

  /** Writes the list of kept jobs as it is now, after what was written before. */
  function save(): Promise<void> {
    const path = options.kept;
    if (!path) return saved;
    const list = [...keeping];
    saved = saved.then(() => writeKept(path, list)).catch((error) =>
      log(`couldn't keep the list of jobs: ${error instanceof Error ? error.message : error}`)
    );
    return saved;
  }

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

  /** Jobs as they are now: those running, with the ports they listen on (when that's found). */
  async function withPorts(list: Entry[]): Promise<Job[]> {
    const running = list.flatMap((e) => e.job.running && e.child.pid ? [e.child.pid] : []);
    const ports = running.length ? await portsOf(running) : undefined;
    return list.map((e) => {
      const found = e.job.running && e.child.pid ? ports?.get(e.child.pid) : undefined;
      return found ? { ...e.job, ports: found } : e.job;
    });
  }

  /** Starts a job in a space's folder; `kept` when it's in the list of kept jobs. */
  async function launch(scope: Scope, input: JobsStartInput, kept?: KeptJob): Promise<Job> {
    if (closed) fail("The computer is stopping", "stopping");
    const { folder: name, who } = checkScope(scope);
    if (typeof input.command !== "string" || !input.command.trim()) fail("command is required");
    if (input.port !== undefined && !isPort(input.port)) fail("port must be from 1 to 65535");
    if (input.keep !== undefined && typeof input.keep !== "boolean") fail("keep is true or false");
    const env = givenEnv(input.env);
    const cwd = await spaces.folder(scope);
    const id = `job-${randomBytes(6).toString("hex")}`;
    const child = spawn(shell.path, commandArgs(shell, input.command), {
      cwd,
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group (see processes.ts), so stopping it reaches everything it starts.
      ...OWN,
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
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.keep ? { keep: true } : {}),
      },
      folder: name,
      child,
      stdout: "",
      stderr: "",
      dropped: false,
      exited: Promise.resolve(),
    };
    for (const stream of ["stdout", "stderr"] as const) {
      const lines = newlines(shell);
      child[stream]!.setEncoding("utf8");
      child[stream]!.on("data", (text: string) => keep(entry, stream, lines.text(text)));
      child[stream]!.on("end", () => keep(entry, stream, lines.end()));
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
        // Ended while the computer runs, it's no longer kept; the computer stopping keeps it.
        if (entry.kept && !closed) {
          keeping.delete(entry.kept);
          entry.kept = undefined;
          void save();
        }
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
    if (input.keep) {
      entry.kept = kept ?? {
        folder: name,
        who,
        name: entry.job.name,
        command: input.command,
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(env && Object.keys(env).length ? { env } : {}),
      };
      keeping.add(entry.kept);
      await save();
    }
    return entry.job;
  }

  return {
    start: (input: JobsStartInput): Promise<Job> => launch(input.scope, input),

    /** Starts again the jobs the computer keeps, as its list has them (it's starting). */
    async resume() {
      if (!options.kept) return;
      let list: KeptJob[];
      try {
        list = await readKept(options.kept);
      } catch (error) {
        return log(
          `couldn't read the list of jobs: ${error instanceof Error ? error.message : error}`,
        );
      }
      for (const kept of list) {
        // Only the folder and who matter to a job: its space is its folder's.
        const scope = { space: kept.folder, folder: kept.folder, who: kept.who };
        await launch(scope, { scope, ...kept, keep: true }, kept).catch((error) =>
          log(
            `couldn't start "${kept.name}" again: ${
              error instanceof Error ? error.message : error
            }`,
          )
        );
      }
      // What couldn't start leaves the list.
      await save();
    },

    async list(input: JobsListInput): Promise<Job[]> {
      const { folder, who } = checkScope(input.scope);
      return await withPorts(
        [...entries.values()].filter((e) =>
          e.folder === folder && (input.all === true || e.job.who === who)
        ),
      );
    },

    async logs(input: JobsLogsInput): Promise<JobsLogs> {
      const entry = mine(input.scope, input.id);
      const tail = typeof input.tail === "number" && input.tail >= 0 ? input.tail : undefined;
      const cut = (text: string) => tail === undefined ? text : tail === 0 ? "" : text.slice(-tail);
      const stdout = cut(entry.stdout);
      const stderr = cut(entry.stderr);
      const [job] = await withPorts([entry]);
      return {
        job,
        stdout,
        stderr,
        truncated: entry.dropped || stdout.length < entry.stdout.length ||
          stderr.length < entry.stderr.length,
      };
    },

    /** SIGTERM to its group, then SIGKILL after the grace; answers once it's ended (and unkept). */
    async stop(input: JobsStopInput): Promise<Job> {
      const entry = mine(input.scope, input.id);
      if (!entry.job.running) return entry.job;
      signalGroup(entry.child.pid, "SIGTERM");
      const timer = setTimeout(() => signalGroup(entry.child.pid, "SIGKILL"), stopGraceMs);
      await entry.exited;
      clearTimeout(timer);
      await saved;
      return entry.job;
    },

    /** Every job stops (the computer is stopping); the list of kept jobs stays as it is. */
    async stopAll() {
      closed = true;
      await Promise.all([...entries.values()].map(async (entry) => {
        if (!entry.job.running) return;
        signalGroup(entry.child.pid, "SIGTERM");
        const timer = setTimeout(() => signalGroup(entry.child.pid, "SIGKILL"), 1000);
        await entry.exited;
        clearTimeout(timer);
      }));
      await saved;
    },
  };
}
