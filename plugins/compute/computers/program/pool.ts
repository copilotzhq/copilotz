/**
 * The program on a pool VM (`computer pool`): a free VM of an app's pool of
 * cloud computers, connected to the app as an Oxian worker of the `pool`
 * kind (its id the VM's name), until it's given a computer to serve, for one
 * wake (see cloud/contract.ts).
 *
 * Assigned one (`pool.assign`), it mounts the computer's disk as its root
 * (formatting it first, its first wake), and runs it as a laptop does
 * (startComputer): its state on the disk (`.copilotz/computer.json`), its
 * spaces under `spaces/`, its kept jobs started again. The first time, it
 * enrolls with the code the assignment carries and keeps its id and secret
 * on the disk. It answers once the computer is connected. Released
 * (`pool.release`), it stops the computer (its jobs stop; the list of those
 * it keeps stays on the disk), syncs and unmounts; then the app deletes the
 * VM. It serves one computer, once: another is turned away, while it serves
 * (`busy`) and after (`denied`), as a VM that served one never serves
 * another.
 *
 * It registers as `pool:<token>`: a token given (the local host's), else, on
 * Compute Engine, the VM's identity token for the app (`pool:gce:<jwt>`),
 * fetched for each registration, as it expires.
 */
import { createWorker, type Worker } from "@oxian/oxian-js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { POOL, type PoolAssign, type PoolRelease } from "../../cloud/contract.ts";
import { type Computer, type ComputerOptions, startComputer } from "./computer.ts";
import { connectionOf, loadState, reachable, sameApp, socketUrl, updateState } from "./state.ts";
import { answer, fail } from "./workloads/answer.ts";
import { WINDOWS } from "./workloads/processes.ts";

/** Compute Engine's metadata server. */
export const METADATA = "http://metadata.google.internal/computeMetadata/v1";

export type PoolOptions = {
  /** The app's URL (`http(s)://host`), or its socket. */
  app: string;
  /** The VM's name: the metadata server's unless given. */
  vm?: string;
  /** Its pool token: the VM's identity token for the app (from the metadata server) unless given. */
  token?: string;
  /** Where a computer's disk is mounted (`/mnt/computer`). */
  root: string;
  /** The metadata server, unless Compute Engine's. */
  metadata?: string;
  /** How the computers it serves run, beyond what assignments say (tests: no Chrome). */
  computer?: Partial<ComputerOptions>;
  /** How long a disk gets to appear once assigned, and the computer to connect. */
  deviceMs?: number;
  connectMs?: number;
  /** Where its concise log lines go (never a secret). */
  log?: (line: string) => void;
};

export type Pool = {
  /** The VM's name: its id in the pool. */
  vm: string;
  /** When it's first connected and admitted. */
  ready: Promise<void>;
  /** When it's stopped; it fails (`refused`) when the app turns it away. */
  closed: Promise<void>;
  /** Releases the computer it serves (if one), and disconnects. */
  stop(): Promise<void>;
};

/** A computer it serves (or is starting to). */
type Serving = {
  computer: string;
  /** Where its disk is mounted, when it mounted one. */
  mounted?: string;
  running?: Computer;
  /** Stops it starting, when it's released first. */
  halt: AbortController;
  started: Promise<void>;
  released?: Promise<void>;
};

/**
 * What its identity tokens are for: the app's origin, as the app checks them
 * (`https://host`), also when it's given the app's socket (`wss://host/…`).
 */
export const audienceOf = (app: string): string =>
  new URL(app.replace(/^ws(s?):/i, "http$1:")).origin;

/** Waits `ms`, or until `signal` aborts. */
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

/** Runs a system command, failing with what it said when it fails. */
function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 120_000, windowsHide: true }, (error, _out, err) => {
      if (!error) return resolve();
      const said = String(err).trim().split("\n").pop() || error.message;
      reject(Object.assign(new Error(`${command} failed: ${said}`), { code: "failed" }));
    });
  });
}

/** Something the metadata server says (`path` under its v1). */
async function metadata(base: string, path: string): Promise<string> {
  const response = await fetch(`${base}/${path}`, {
    headers: { "Metadata-Flavor": "Google" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The metadata server answered ${response.status} for ${path}`);
  return (await response.text()).trim();
}

/** Waits up to `ms` for a device to appear (the disk attached to this VM). */
async function appear(device: string, ms: number, signal: AbortSignal) {
  const end = Date.now() + ms;
  while (!(await stat(device).then(() => true, () => false))) {
    if (signal.aborted) fail("Released while it waited for its disk", "stopping");
    if (Date.now() > end) fail(`The disk ${device} didn't appear in ${ms / 1000} s`, "not_found");
    await wait(250, signal);
  }
}

/** Unmounts `path`; what still holds it (a job's process that left its group) is ended first. */
async function unmount(path: string) {
  for (let tries = 1;; tries++) {
    try {
      return await run("umount", [path]);
    } catch (error) {
      if (tries === 1) await run("fuser", ["-km", path]).catch(() => {});
      if (tries === 10) throw error;
      await wait(500);
    }
  }
}

/** Connects this VM to the app's pool, and serves what it's assigned. */
export async function startPool(options: PoolOptions): Promise<Pool> {
  const log = options.log ?? ((line: string) => console.log(line));
  const url = reachable(socketUrl(options.app));
  const base = options.metadata ?? METADATA;
  const vm = options.vm ?? await metadata(base, "instance/name");
  const audience = audienceOf(options.app);
  /** What it registers with: its token, or a fresh identity token for the app. */
  const credential = async () =>
    options.token ? `pool:${options.token}` : `pool:gce:${await metadata(
      base,
      `instance/service-accounts/default/identity?audience=${
        encodeURIComponent(audience)
      }&format=full`,
    )}`;

  let serving: Serving | undefined;
  /** The computer it served, once it served one: the only one it serves again. */
  let served: string | undefined;

  /** Mounts its disk, readies its state, and runs it, until it's connected. */
  async function begin(current: Serving, input: PoolAssign) {
    const { signal } = current.halt;
    const halted = () => signal.aborted && fail("Released before it started", "stopping");
    let root: string;
    if (input.device.startsWith("/dev/")) {
      await appear(input.device, options.deviceMs ?? 60_000, signal);
      halted();
      if (input.format) await run("mkfs.ext4", ["-q", "-F", input.device]);
      await mkdir(options.root, { recursive: true });
      halted();
      await run("mount", ["-o", "discard,defaults", input.device, options.root]);
      current.mounted = options.root;
      root = options.root;
    } else {
      // A folder that stands for its disk (a local host's), mounted already.
      if (!isAbsolute(input.device)) fail("device must be a /dev/ path or an absolute folder");
      await mkdir(input.device, { recursive: true });
      root = await realpath(input.device);
    }
    const statePath = join(root, ".copilotz", "computer.json");
    const spaces = join(root, "spaces");
    // Where it connects: the app's address for it (its org's, in an app of many), else the pool's.
    const app = input.app ?? options.app;
    // The disk is this app's computer: kept under another of its URLs (it moved), it's this one's.
    const state = await loadState(statePath);
    const kept = connectionOf(state, app) ??
      (state?.connections.length === 1 ? state.connections[0] : undefined);
    if (kept?.id && kept.id !== input.computer) {
      fail(`This disk is computer ${kept.id}'s, not ${input.computer}'s`, "invalid");
    }
    if (!(kept?.id && kept.secret) && !input.code) {
      fail(`${input.computer} isn't enrolled yet: its first wake needs a code`);
    }
    if (kept && (!sameApp(kept.url, app) || kept.root !== spaces)) {
      await updateState(statePath, (state) => ({
        ...state,
        connections: [{ ...kept, url: app, root: spaces }],
      }));
    }
    halted();
    const computer = current.running = await startComputer({
      url: app,
      root: spaces,
      statePath,
      ...(input.code ? { code: input.code } : {}),
      ...(input.name ? { name: input.name } : {}),
      // Pool VMs don't update themselves (their image does), nor have a screen.
      program: null,
      windows: "never",
      log: (line) => log(`${input.computer}: ${line}`),
      ...options.computer,
    });
    const ms = options.connectMs ?? 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const gone = computer.closed.then(() => fail("The computer stopped before it connected"));
    gone.catch(() => {});
    try {
      await Promise.race([
        computer.ready,
        gone,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Object.assign(new Error(`It didn't connect in ${ms / 1000} s`), {
                code: "failed",
              })),
            ms,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    halted();
  }

  /**
   * Stops serving `current`: it stops starting, the computer stops (its jobs
   * too, their list kept), and its disk is synced and unmounted.
   */
  function end(current: Serving): Promise<void> {
    return current.released ??= (async () => {
      current.halt.abort();
      await current.started.catch(() => {});
      await current.running?.stop();
      if (!WINDOWS) await run("sync", []).catch(() => {});
      if (current.mounted) await unmount(current.mounted);
      if (serving === current) serving = undefined;
    })();
  }

  const workloads = {
    [POOL.assign]: answer(async (input: PoolAssign) => {
      if (typeof input?.computer !== "string" || !input.computer) fail("computer is required");
      if (typeof input.device !== "string" || !input.device) fail("device is required");
      for (const key of ["code", "name", "app"] as const) {
        if (input[key] !== undefined && typeof input[key] !== "string") {
          fail(`${key} must be a string`);
        }
      }
      // Being released: once it is, the VM is free again (for that computer).
      if (serving?.released) await serving.released.catch(() => {});
      if (serving?.released) fail(`This VM couldn't release ${serving.computer}`, "busy");
      if (serving) {
        // Asked again (its answer was lost): it answers as the first does.
        if (serving.computer !== input.computer) {
          fail(`This VM serves ${serving.computer}`, "busy");
        }
        await serving.started;
        return { ok: true };
      }
      if (served && served !== input.computer) {
        fail(`This VM served ${served}: a VM serves one computer, never another`, "denied");
      }
      served = input.computer;
      const current: Serving = {
        computer: input.computer,
        halt: new AbortController(),
        started: Promise.resolve(),
      };
      serving = current;
      log(`serving ${input.computer}…`);
      current.started = begin(current, input);
      try {
        await current.started;
      } catch (error) {
        log(`couldn't serve ${input.computer}: ${error instanceof Error ? error.message : error}`);
        await end(current).catch(() => {});
        throw error;
      }
      log(`serving ${input.computer}`);
      return { ok: true };
    }),
    [POOL.release]: answer(async (input: PoolRelease) => {
      if (typeof input?.computer !== "string" || !input.computer) fail("computer is required");
      const current = serving;
      // Nothing to release: released already.
      if (!current) return { ok: true };
      if (current.computer !== input.computer) {
        fail(`This VM serves ${current.computer}, not ${input.computer}`, "invalid");
      }
      log(`releasing ${input.computer}…`);
      await end(current);
      log(`released ${input.computer}`);
      return { ok: true };
    }),
  };

  // One attempt per process, kept across reconnects, so Oxian can fence a replaced one.
  const attempt = { attemptId: randomUUID(), epoch: Date.now() };
  const halt = new AbortController();
  let stopping = false;
  let connection: Worker | undefined;
  let readied!: () => void;
  let unready!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readied = resolve;
    unready = reject;
  });
  ready.catch(() => {});

  const closed = (async () => {
    for (let failures = 0; !stopping;) {
      const worker = connection = createWorker({
        id: vm,
        transport: { type: "websocket", config: { url, allowInsecureLoopback: true } },
        activate: ({ workerId }) => ({ identity: { workerId, ...attempt } }),
        register: async () => ({
          credential: { kind: "registration", capability: await credential() },
          expiresAtMs: Date.now() + 60_000,
        }),
        capacity: 8,
        workloads,
      });
      worker.ready.then(() => {
        failures = 0;
        log(`connected to ${url} as pool VM ${vm}`);
        readied();
      }, () => {});
      try {
        const result = await worker.closed;
        if (stopping) break;
        // The app forgot this session (it restarted): register again, now.
        if (result.reason === "reenrollment_required") continue;
        log("disconnected; reconnecting…");
      } catch (error) {
        if (stopping) break;
        const code = (error as { code?: string })?.code;
        // Turned away while it serves a computer, it keeps trying: the computer runs on.
        if (code === "credential_rejected" && !serving) {
          const refused = Object.assign(
            new Error(`The app didn't take this VM (${vm}) into its pool`),
            { code: "refused" as const },
          );
          unready(refused);
          throw refused;
        }
        log(`connection failed (${error instanceof Error ? error.message : error}); retrying…`);
      }
      await wait(Math.min(30_000, 500 * 2 ** failures++), halt.signal);
    }
  })();
  closed.catch(() => {});

  let stopped: Promise<void> | undefined;
  return {
    vm,
    ready,
    closed,
    stop() {
      return stopped ??= (async () => {
        stopping = true;
        halt.abort();
        unready(new Error("The pool VM stopped"));
        if (serving) await end(serving).catch(() => {});
        await connection?.stop().catch(() => {});
        await closed.catch(() => {});
      })();
    },
  };
}
