/**
 * A cloud for tests, in memory: a `CloudHost` whose disks and snapshots are
 * entries in maps, and whose VMs are in-process Oxian workers of the `pool`
 * kind, connecting on `topic` as Compute Engine's would. Told to serve a
 * computer (`pool.assign`), a VM connects a fake computer for it: with the
 * code, the first time (and keeps what it's told on its disk, as the program
 * does), else with what its disk keeps. Told to release it, it disconnects
 * it. Its pools keep as many free VMs as they're asked to; taking one starts
 * another, as an instance group does.
 */
import { createWorker } from "@oxian/oxian-js";
import { type CloudHost, type Placement, POOL, type PoolAssign } from "../cloud/contract.ts";
import { type Job, WORK } from "../computers/shared/workloads.ts";

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const read = async <T>(input: ReadableStream<Uint8Array>) =>
  JSON.parse(await new Response(input).text()) as T;

/** One Oxian worker on `topic`, presenting `capability`, serving `workloads` (JSON in, JSON out). */
function worker(
  topic: string,
  capability: string,
  workloads: Record<string, (input: Record<string, unknown>) => unknown>,
) {
  const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };
  return createWorker({
    id: `worker-${crypto.randomUUID()}`,
    transport: { type: "in-process", config: { topic } },
    activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
    register: () =>
      Promise.resolve({
        credential: { kind: "registration" as const, capability },
        expiresAtMs: Date.now() + 60_000,
      }),
    capacity: 8,
    workloads: Object.fromEntries(
      Object.entries(workloads).map(([name, reply]) => [
        name,
        async ({ input }: { input: ReadableStream<Uint8Array> }) =>
          json(await reply(await read<Record<string, unknown>>(input))),
      ]),
    ),
  });
}

/**
 * A computer as the program is one: it connects with `credential`, keeps
 * the id and secret it's told (`onEnrolled`), says what it is, runs commands
 * (answering what it ran), and lists the jobs `jobs` says it runs.
 */
export function fakeCloudComputer(
  topic: string,
  credential: string,
  options: { jobs?: () => Job[]; onEnrolled?: (credential: string) => void } = {},
) {
  const asked: { work: string; input: Record<string, unknown> }[] = [];
  const said = (work: string, reply: (input: Record<string, unknown>) => unknown) => ({
    [work]: (input: Record<string, unknown>) => {
      asked.push({ work, input });
      return reply(input);
    },
  });
  const w = worker(topic, `computer:${credential}`, {
    ...said(WORK.enrolled, (input) => {
      options.onEnrolled?.(`${input.id}.${input.secret}`);
      return {};
    }),
    ...said(WORK.info, () => ({
      os: "linux",
      arch: "x64",
      hostname: "pool-vm",
      root: "/mnt/disk",
      shell: "bash",
      browser: null,
      version: "test",
    })),
    ...said(WORK.terminal, (input) => ({
      state: "idle",
      commandId: "c1",
      stdout: `ran ${input.stdin}`,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      timedOut: false,
      durationMs: 1,
      cwd: ".",
    })),
    ...said(WORK.jobsList, () => options.jobs?.() ?? []),
  });
  return { worker: w, asked };
}

/** A pool worker's work, doing nothing. */
const idle = { [POOL.assign]: () => ({ ok: true }), [POOL.release]: () => ({ ok: true }) };

/** A computer's disk as the program sees it: the state it keeps (its id and secret), and formatting. */
export type FakeDisk = {
  read(): Promise<string | undefined>;
  write(state: string): Promise<void>;
  format(): Promise<void>;
};

/**
 * The computer program in pool mode, as a test's in-process worker: it
 * connects with `token` (`pool:<token>`); told to serve a computer, it finds
 * its disk at the device (`disk`), formats it the first time, and connects
 * the computer, with the code or with the state its disk keeps (written once
 * it's told it); told to release it, it disconnects it.
 */
export function fakePoolProgram(
  topic: string,
  token: string,
  disk: (device: string) => FakeDisk | undefined,
  options: { jobs?: () => Job[]; topics?: Record<string, string> } = {},
) {
  const assigned: PoolAssign[] = [];
  const vm = {
    assigned,
    computer: undefined as ReturnType<typeof fakeCloudComputer> | undefined,
    worker: worker(topic, `pool:${token}`, {
      [POOL.assign]: async (input) => {
        const given = input as PoolAssign;
        assigned.push(given);
        const found = disk(given.device);
        if (!found) return { error: { message: `nothing at ${given.device}`, code: "failed" } };
        if (given.format) await found.format();
        const credential = given.code ? `code:${given.code}` : await found.read();
        if (!credential) return { error: { message: "no state on the disk", code: "failed" } };
        const at = given.app ? options.topics?.[given.app] : undefined;
        if (given.app && !at) {
          return { error: { message: `no app at ${given.app}`, code: "failed" } };
        }
        vm.computer = fakeCloudComputer(at ?? topic, credential, {
          jobs: options.jobs,
          onEnrolled: (told) => void found.write(told),
        });
        await vm.computer.worker.ready;
        return { ok: true };
      },
      [POOL.release]: async () => {
        await vm.computer?.worker.stop();
        vm.computer = undefined;
        return { ok: true };
      },
    }),
    async stop() {
      await vm.computer?.worker.stop().catch(() => {});
      await vm.worker.stop().catch(() => {});
    },
  };
  return vm;
}

type FakeVm = ReturnType<typeof fakePoolProgram> & {
  name: string;
  size: string;
  placement: Placement;
  pooled: boolean;
  /** Disks attached, by device. */
  devices: Map<string, string>;
};

/** Where a disk keeps a computer's state: its id and secret, once it's been told them. */
type Disk = { gb: number; state?: string };

export function fakeCloud(
  topic: string,
  options: {
    jobs?: () => Job[];
    topics?: Record<string, string>;
    /** While `hold`, a pool's new VMs are booting: none starts until `boot`. */
    booting?: { hold: boolean };
  } = {},
) {
  const disks = new Map<string, Disk>();
  const snapshots = new Map<string, Disk>();
  const vms = new Map<string, FakeVm>();
  const targets = new Map<string, number>();
  /** What the host was asked, in order. */
  const calls: string[] = [];
  let made = 0;

  const key = (p: Placement, size: string) => `${p.project}/${p.zone}/${size}`;
  const pooled = (p: Placement, size: string) =>
    [...vms.values()].filter((vm) =>
      vm.pooled && vm.size === size && key(vm.placement, size) === key(p, size)
    );

  /** A VM of a pool, connecting as a pool worker with its token (`fake:<name>`). */
  function startVm(placement: Placement, size: string, pooledIn = true): FakeVm {
    const name = `vm-${size}-${++made}`;
    const devices = new Map<string, string>();
    // As Compute Engine's: the disk attached as `device` is at /dev/disk/by-id/google-<device>.
    const program = fakePoolProgram(topic, `fake:${name}`, (path) => {
      const disk = disks.get(devices.get(path.replace("/dev/disk/by-id/google-", "")) ?? "");
      return disk && {
        read: () => Promise.resolve(disk.state),
        write: (state) => Promise.resolve(void (disk.state = state)),
        format: () => Promise.resolve(void delete disk.state),
      };
    }, options);
    const vm: FakeVm = Object.assign(program, {
      name,
      size,
      placement,
      pooled: pooledIn,
      devices,
    });
    vms.set(name, vm);
    return vm;
  }

  async function stopVm(vm: FakeVm) {
    vms.delete(vm.name);
    await vm.stop();
  }

  /** Starts or stops a pool's free VMs until it has its target. */
  async function fill(p: Placement, size: string) {
    const target = targets.get(key(p, size)) ?? 0;
    while (!options.booting?.hold && pooled(p, size).length < target) startVm(p, size);
    while (pooled(p, size).length > target) await stopVm(pooled(p, size).at(-1)!);
  }

  const host: CloudHost = {
    createDisk(_p, disk, gb) {
      calls.push(`createDisk ${disk}`);
      if (disks.has(disk)) return Promise.reject(new Error(`${disk} exists`));
      disks.set(disk, { gb });
      return Promise.resolve();
    },
    deleteDisk(_p, disk) {
      calls.push(`deleteDisk ${disk}`);
      disks.delete(disk);
      return Promise.resolve();
    },
    snapshot(_p, disk, snapshot) {
      calls.push(`snapshot ${disk} ${snapshot}`);
      const found = disks.get(disk);
      if (!found) return Promise.reject(new Error(`no ${disk}`));
      snapshots.set(snapshot, { ...found });
      return Promise.resolve();
    },
    restore(_p, snapshot, disk) {
      calls.push(`restore ${snapshot} ${disk}`);
      const found = snapshots.get(snapshot);
      if (!found) return Promise.reject(new Error(`no ${snapshot}`));
      disks.set(disk, { ...found });
      return Promise.resolve();
    },
    deleteSnapshot(_p, snapshot) {
      calls.push(`deleteSnapshot ${snapshot}`);
      snapshots.delete(snapshot);
      return Promise.resolve();
    },
    attach(_p, name, disk, device) {
      calls.push(`attach ${name} ${disk} ${device}`);
      const vm = vms.get(name);
      if (!vm || !disks.has(disk)) return Promise.reject(new Error(`can't attach ${disk}`));
      vm.devices.set(device, disk);
      // As Compute Engine: the VM sees it at /dev/disk/by-id/google-<device>.
      return Promise.resolve();
    },
    detach(_p, name, disk, force) {
      calls.push(`detach ${name} ${disk}${force ? " force" : ""}`);
      const vm = vms.get(name);
      for (const [device, d] of vm?.devices ?? []) if (d === disk) vm!.devices.delete(device);
      return Promise.resolve();
    },
    pool(p, size) {
      return Promise.resolve({
        target: targets.get(key(p, size)) ?? 0,
        vms: pooled(p, size).map((vm) => vm.name),
      });
    },
    async resize(p, size, target) {
      calls.push(`resize ${size} ${target}`);
      targets.set(key(p, size), target);
      await fill(p, size);
    },
    async take(p, size, name) {
      calls.push(`take ${name}`);
      const vm = vms.get(name);
      if (!vm?.pooled) throw new Error(`${name} isn't in the pool`);
      vm.pooled = false;
      await fill(p, size);
    },
    async deleteVm(_p, name) {
      calls.push(`deleteVm ${name}`);
      const vm = vms.get(name);
      if (vm) await stopVm(vm);
    },
    verify(credential) {
      const vm = credential.startsWith("fake:") ? vms.get(credential.slice(5)) : undefined;
      return Promise.resolve(vm ? { vm: vm.name, placement: vm.placement } : null);
    },
  };

  return {
    host,
    /** The VMs a held pool was booting start now. */
    boot: (p: Placement, size: string) => fill(p, size),
    disks,
    snapshots,
    vms,
    calls,
    /** A VM of no pool the app has (another project's), connecting all the same. */
    outsider: () => startVm({ project: "elsewhere", zone: "nowhere" }, "small", false),
    /** Another connection presenting a VM's own token (as an agent root on it could). */
    again: (name: string) => worker(topic, `pool:fake:${name}`, idle),
    /** One presenting a token nobody issued. */
    stranger: () => worker(topic, "pool:fake:nobody", idle),
    async close() {
      for (const vm of [...vms.values()]) await stopVm(vm);
    },
  };
}
