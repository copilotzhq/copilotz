/**
 * A cloud on this machine, for development and tests (`host: "local"`):
 *
 * - **disks** are folders under its directory (`<dir>/<account>/<project>/<zone>/disks/<disk>`),
 *   and **snapshots** copies of them;
 * - **VMs** are processes it starts, each running the computer program in
 *   pool mode (`deno run -A …/computers/program/main.ts pool --app <url> --vm <name>`,
 *   with its token, `local:<name>.<secret>`, in `COPILOTZ_POOL_TOKEN`), or
 *   whatever `launch` starts instead (a test's in-process worker);
 * - **pools** keep as many such VMs as they're asked to; taking one starts
 *   another;
 * - **attaching** a disk gives the VM its folder (what `PoolAssign.device`
 *   is: the folder's path);
 * - **verifying** passes only the `local:` tokens it gave its VMs.
 *
 * What it knows of its VMs lives in this process: VMs it started before a
 * restart don't connect again.
 *
 * ```ts
 * adapters: { cloudHost: { local: localHost({ dir: ".cloud", app: "http://localhost:8000" }) } }
 * ```
 */
import type { CloudHost, CloudHostAdapter, Placement } from "../contract.ts";
import { appOf, placeKey } from "../shared/settings.ts";

/** A VM it started: what stops it. */
export type LocalVm = { stop(): void | Promise<void> };

/** Starts a VM: something that connects to `app` as a pool worker with `token`. */
export type LocalLaunch = (vm: {
  name: string;
  token: string;
  app: string;
  placement: Placement;
  size: string;
}) => LocalVm | Promise<LocalVm>;

export type LocalHostOptions = {
  /** Where its disks and snapshots go (a folder in the system's temporary one by default). */
  dir?: string;
  /** The app's address, as its VMs reach it; by default the computers plugin's `url`. */
  app?: string;
  /** The computer program (this Copilotz's own by default). */
  program?: string;
  /** How a VM starts (the program, in a process of its own, by default). */
  launch?: LocalLaunch;
};

type Vm = {
  name: string;
  placement: Placement;
  size: string;
  secret: string;
  started: Promise<LocalVm>;
  /** Its disks, by name: their folders. */
  disks: Map<string, string>;
};

const failure = (message: string, code = "failed") => Object.assign(new Error(message), { code });

const random = (bytes: number) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/**
 * The program, as a process of its own: `deno run -A main.ts pool --app <url> --vm <name>`,
 * its token in its environment (`COPILOTZ_POOL_TOKEN`), where other processes don't list it.
 */
function programLauncher(program: string | undefined): LocalLaunch {
  return async ({ name, token, app }) => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const main = program ??
      fileURLToPath(new URL("../../computers/program/main.ts", import.meta.url));
    // deno-lint-ignore no-explicit-any
    const g = globalThis as any;
    const child = spawn(
      g.Deno?.execPath?.() ?? "deno",
      ["run", "-A", main, "pool", "--app", app, "--vm", name],
      {
        stdio: "inherit",
        env: { ...(g.process?.env ?? g.Deno?.env?.toObject?.() ?? {}), COPILOTZ_POOL_TOKEN: token },
      },
    );
    return { stop: () => void child.kill("SIGTERM") };
  };
}

/** A local host: one per account it's made for, each in a folder of its own. */
export function localHost(options: LocalHostOptions = {}): CloudHostAdapter {
  return (account, { resources }) => createLocalHost(options, account, resources);
}

export function createLocalHost(
  options: LocalHostOptions,
  account?: string,
  resources: Record<string, Record<string, unknown>> = {},
): CloudHost {
  const launch = options.launch ?? programLauncher(options.program);
  const vms = new Map<string, Vm>();
  const pools = new Map<string, { target: number; vms: Set<string> }>();
  /** Each pool's changes, one after another. */
  const queues = new Map<string, Promise<unknown>>();

  const fs = () => import("node:fs/promises");
  const root = async () => {
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    return join(options.dir ?? join(tmpdir(), "copilotz-cloud"), account ?? "app");
  };
  const folder = async (p: Placement, kind: "disks" | "snapshots", name: string) => {
    const { join } = await import("node:path");
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw failure(`Not a name: ${name}`, "invalid");
    return join(await root(), p.project, p.zone, kind, name);
  };
  const exists = async (path: string) => !!await (await fs()).stat(path).catch(() => null);

  const poolOf = (p: Placement, size: string) => {
    const key = `${placeKey(p)}|${size}`;
    let pool = pools.get(key);
    if (!pool) pools.set(key, pool = { target: 0, vms: new Set() });
    return { key, pool };
  };
  const serially = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (queues.get(key) ?? Promise.resolve()).then(work, work);
    queues.set(key, next.catch(() => {}));
    return next;
  };

  /** A new VM in a pool, started. */
  const start = async (p: Placement, size: string) => {
    const app = options.app ?? appOf(resources);
    if (!app && !options.launch) {
      throw failure(
        "The local cloud needs the app's address: `localHost({ app })`, or the computers " +
          "plugin's `url`.",
        "invalid",
      );
    }
    const name = `cz-pool-${size}-${random(4)}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const secret = random(24);
    const vm: Vm = {
      name,
      placement: p,
      size,
      secret,
      started: Promise.resolve(
        launch({ name, token: `local:${name}.${secret}`, app: app ?? "", placement: p, size }),
      ),
      disks: new Map(),
    };
    vms.set(name, vm);
    poolOf(p, size).pool.vms.add(name);
    await vm.started.catch((error) => {
      vms.delete(name);
      poolOf(p, size).pool.vms.delete(name);
      throw error;
    });
  };

  /** Stops a VM, and forgets it (its disks are detached). */
  const stop = async (name: string) => {
    const vm = vms.get(name);
    if (!vm) return;
    vms.delete(name);
    for (const pool of pools.values()) pool.vms.delete(name);
    await (await vm.started.catch(() => undefined))?.stop();
  };

  /** Starts or stops a pool's free VMs until it has its target. */
  const fill = async (p: Placement, size: string) => {
    const { pool } = poolOf(p, size);
    while (pool.vms.size < pool.target) await start(p, size);
    while (pool.vms.size > pool.target) await stop([...pool.vms].at(-1)!);
  };

  const attachedTo = (disk: string, p: Placement) =>
    [...vms.values()].find((vm) => vm.disks.has(disk) && placeKey(vm.placement) === placeKey(p));

  return {
    async createDisk(p, disk) {
      const path = await folder(p, "disks", disk);
      if (await exists(path)) throw failure(`Disk ${disk} exists`, "exists");
      await (await fs()).mkdir(path, { recursive: true });
    },
    async deleteDisk(p, disk) {
      if (attachedTo(disk, p)) throw failure(`Disk ${disk} is attached`, "busy");
      await (await fs()).rm(await folder(p, "disks", disk), { recursive: true, force: true });
    },
    async snapshot(p, disk, snapshot) {
      const from = await folder(p, "disks", disk);
      if (!await exists(from)) throw failure(`No disk ${disk}`, "not_found");
      await (await fs()).cp(from, await folder(p, "snapshots", snapshot), { recursive: true });
    },
    async restore(p, snapshot, disk) {
      const from = await folder(p, "snapshots", snapshot);
      const to = await folder(p, "disks", disk);
      if (!await exists(from)) throw failure(`No snapshot ${snapshot}`, "not_found");
      if (await exists(to)) throw failure(`Disk ${disk} exists`, "exists");
      await (await fs()).cp(from, to, { recursive: true });
    },
    async deleteSnapshot(p, snapshot) {
      await (await fs()).rm(await folder(p, "snapshots", snapshot), {
        recursive: true,
        force: true,
      });
    },
    async attach(p, name, disk) {
      const vm = vms.get(name);
      if (!vm) throw failure(`No VM ${name}`, "not_found");
      const path = await folder(p, "disks", disk);
      if (!await exists(path)) throw failure(`No disk ${disk}`, "not_found");
      const other = attachedTo(disk, p);
      if (other && other !== vm) throw failure(`Disk ${disk} is attached to ${other.name}`, "busy");
      vm.disks.set(disk, path);
      // What the VM sees: the disk's folder.
      return path;
    },
    detach(_p, name, disk) {
      vms.get(name)?.disks.delete(disk);
      return Promise.resolve();
    },
    pool(p, size) {
      const { pool } = poolOf(p, size);
      return Promise.resolve({ target: pool.target, vms: [...pool.vms] });
    },
    resize(p, size, target) {
      const { key, pool } = poolOf(p, size);
      pool.target = Math.max(0, target);
      return serially(key, () => fill(p, size));
    },
    take(p, size, name) {
      const { key, pool } = poolOf(p, size);
      if (!pool.vms.delete(name)) {
        return Promise.reject(failure(`${name} isn't in the pool`, "not_found"));
      }
      // The pool makes another.
      void serially(key, () => fill(p, size)).catch((error) =>
        console.error("cloud: local pool:", error instanceof Error ? error.message : error)
      );
      return Promise.resolve();
    },
    deleteVm: (_p, name) => stop(name),
    verify(credential) {
      const found = /^local:([a-z0-9-]+)\.([0-9a-f]+)$/.exec(credential);
      const vm = found && vms.get(found[1]);
      return Promise.resolve(
        vm && vm.secret === found![2] ? { vm: vm.name, placement: vm.placement } : null,
      );
    },
  };
}
