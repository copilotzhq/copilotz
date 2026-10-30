/**
 * Cloud computers' contract (see design/cloud-computers.md): what the cloud
 * plugins, their hosts (adapters: Compute Engine, a local one for development
 * and tests) and the computer program's pool mode agree on. Plain types and
 * names only.
 *
 * A cloud computer is a computer (the computers plugin's record, its desks,
 * its work) whose machine the app keeps: its disk holds it (its spaces'
 * folders, its state, the jobs it keeps running), and a VM from a pool
 * serves it for one wake, then goes.
 *
 * Two plugins:
 *
 * - **`cloud`**, where the computers are (each org's runtime): their records,
 *   disks and snapshots, waking, releasing, metering. It reaches the pools
 *   only through the pool's Actions (`POOL_ACTIONS`).
 * - **`cloudPool`**, where pool VMs connect (the app's one runtime, or, in
 *   an app of many orgs, one runtime for them all: the directory's): the
 *   pools' VMs, their admission (the `pool` worker kind), taking one for a
 *   computer, telling it to serve and stop, deleting it, the pools' sizes.
 *   Each VM it gives is leased: whoever took it renews it while the computer
 *   uses it (`pool.renew`, each minute), and one whose lease ran out is
 *   deleted, so a VM nobody answers for never runs on.
 *
 * In one runtime, both plugins; in many, `cloud` in each org's with
 * `remotePool`, whose Actions forward to the runtime that has `cloudPool`.
 */

/** Where a computer's disk and its VMs are: whose cloud account, its project, its zone. */
export type Placement = {
  /** Whose cloud it is: the app's (absent), or an org's own (later). */
  account?: string;
  project: string;
  zone: string;
};

/** A size people choose, as the app offers it (`cloud` settings). */
export type Size = {
  /** What people read: "Small". */
  label: string;
  /** The host's machine (Compute Engine: `e2-medium`). */
  machine: string;
  vcpu: number;
  /** GiB. */
  memory: number;
  /** Whether its vCPUs are shared (bursting) rather than its own. */
  shared?: boolean;
};

/** A cloud computer's state. */
export type CloudState =
  /** Its disk is a snapshot (unused for `coldDays`); waking makes the disk again first. */
  | "cold"
  /** Its disk is there, with no VM. */
  | "asleep"
  /** Taking a VM and attaching its disk. */
  | "waking"
  /** On a VM, connected (or about to be). */
  | "awake"
  /** Stopping, unmounting and detaching; then its VM is deleted. */
  | "releasing";

/**
 * What the app keeps about a cloud computer (collection `cloudComputer`, its
 * `_id` the computer's).
 */
export type CloudComputer = {
  _id: string;
  /** The person whose it is (as the computer record says), and the org it's billed to. */
  owner: string;
  size: string;
  placement: Placement;
  /** Its disk's name, and its size (GB). */
  disk: string;
  diskGb: number;
  /** Its snapshot's name, while cold. */
  snapshot?: string;
  state: CloudState;
  /** The VM serving it, while waking, awake or releasing. */
  vm?: string;
  /** When it was last used (an agent's or a person's work, a preview's request). */
  used?: string;
  /** When it last woke (its VM's seconds are metered from here), and was last metered to. */
  woke?: string;
  metered?: string;
  /** Whether its disk has been formatted and its state written (its first wake did). */
  ready?: boolean;
  /** When a person last had it open (its terminal, a preview): it stays warm, up to `viewMinutes`. */
  viewed?: string;
  /** When its disk (or, cold, its snapshot) was last metered to. */
  stored?: string;
  at: string;
};

/** A VM in a pool (collection `poolVm`, its `_id` the VM's name). */
export type PoolVm = {
  _id: string;
  placement: Placement;
  size: string;
  state: "free" | "assigned" | "gone";
  /** The computer it serves, once assigned, and whose it is (its org, in an app of many). */
  computer?: string;
  org?: string;
  at: string;
  /** When it last connected. */
  seen?: string;
  /** When it was taken for its computer, and until when it's leased (renewed while it's used). */
  taken?: string;
  until?: string;
  /** When it was told to stop serving its computer: it never connects again. */
  released?: string;
};

/**
 * The cloud a host adapter drives (resource `cloudHost`'s adapter). Every
 * call names the placement it's for; an adapter is made per placement's
 * account, with its own credentials (never one global client).
 */
export type CloudHost = {
  createDisk(placement: Placement, disk: string, gb: number): Promise<void>;
  deleteDisk(placement: Placement, disk: string): Promise<void>;
  /** Snapshots a disk (attached or not), then the disk can be deleted. */
  snapshot(placement: Placement, disk: string, snapshot: string): Promise<void>;
  /** Makes a disk from a snapshot, in this placement (its zone). */
  restore(placement: Placement, snapshot: string, disk: string, gb: number): Promise<void>;
  deleteSnapshot(placement: Placement, snapshot: string): Promise<void>;
  /**
   * Attaches a disk to a VM as `device` (seen in the VM as
   * `/dev/disk/by-id/google-<device>`). A host whose VMs see it elsewhere
   * answers where (a local host: the disk's folder); that's `PoolAssign.device`.
   */
  attach(placement: Placement, vm: string, disk: string, device: string): Promise<string | void>;
  /** Detaches it; `force` when the VM's gone or doesn't answer. */
  detach(placement: Placement, vm: string, disk: string, force?: boolean): Promise<void>;
  /** A size's pool here: the free VMs it's asked to keep, and the VMs in it now. */
  pool(placement: Placement, size: string): Promise<{ target: number; vms: string[] }>;
  /** Asks a size's pool here to keep `target` VMs. */
  resize(placement: Placement, size: string, target: number): Promise<void>;
  /** Takes a VM out of its pool (it's the computer's now); the pool makes another. */
  take(placement: Placement, size: string, vm: string): Promise<void>;
  deleteVm(placement: Placement, vm: string): Promise<void>;
  /**
   * Who a pool VM connecting with `credential` is (a Compute Engine identity
   * token for `audience`, say), or null: only VMs of the app's pools pass.
   */
  verify(
    credential: string,
    audience: string,
  ): Promise<{ vm: string; placement: Placement } | null>;
};

/**
 * A host adapter, as an app gives it (the `cloudHost` adapters, by the name
 * the `cloud` settings' `host` says): the host for a placement's account
 * (undefined: the app's own), made once per account and runtime, with what
 * the runtime's resources say (the app's address, say); or one host for
 * every account.
 *
 * ```ts
 * adapters: { cloudHost: { gce: (account, { resources }) => gceHost(credentialsOf(account)) } }
 * ```
 */
export type CloudHostAdapter =
  | CloudHost
  | ((
    account: string | undefined,
    given: { resources: Record<string, Record<string, unknown>> },
  ) => CloudHost | Promise<CloudHost>);

/** The worker kind pool VMs connect as, and the work they serve. */
export const POOL_KIND = "pool";
export const POOL = {
  /** Serve this computer: mount its disk, read (or, the first time, write) its state, run it. */
  assign: "pool.assign",
  /** Stop serving it: stop its jobs (keeping those it keeps), unmount; then the VM is deleted. */
  release: "pool.release",
} as const;

/**
 * `pool.assign`'s input. It answers `{ ok: true }` once the computer runs
 * (then it connects as itself, `computer:<id>.<secret>`), or `Failed`.
 */
export type PoolAssign = {
  computer: string;
  /** Its disk, as the VM sees it: `/dev/disk/by-id/google-<device>` (a local host: a folder). */
  device: string;
  /** Its secret, the first time (written to its state on the disk), and its name. */
  secret?: string;
  name?: string;
  /**
   * An enrollment code, the first time: the computer connects with it
   * (`computer:code:<code>`), and the app's `computer.enrolled` gives it its
   * id and secret, which it keeps on the disk. The program uses this, not
   * `secret`.
   */
  code?: string;
  /** Format the disk first (its first wake). */
  format?: boolean;
  /**
   * The app's URL as the computer connects to it (its org's address, in an
   * app of many: `https://app/o/<org>`); the program's own `--app` when absent.
   */
  app?: string;
};
export type PoolRelease = { computer: string };

/**
 * The pool's Actions (plugin `cloudPool`, or `remotePool`'s forwarding
 * them), run as the system. `org` is whose the computer is, in an app of
 * many (`remotePool` adds it): a VM taken for one org is only its.
 *
 * - `pool.take` `PoolTake` → `{ vm }`: a free VM of a size in a placement,
 *   taken out of its pool for a computer (none free: the pool grows by one,
 *   and it waits for it), leased.
 * - `pool.serve` `{ vm, assign: PoolAssign }` → the VM's answer to `pool.assign`.
 * - `pool.stop` `{ vm, computer }` → its answer to `pool.release` (`{ error }`
 *   when it gives none).
 * - `pool.drop` `{ vm, placement? }`: the VM is deleted.
 * - `pool.renew` `{ vms, now? }`: their leases go on.
 * - `pool.tick` `{ now? }` (each minute, where `cloudPool` is): pools sized,
 *   VMs whose lease ran out deleted.
 */
export const POOL_ACTIONS = {
  take: "pool.take",
  serve: "pool.serve",
  stop: "pool.stop",
  drop: "pool.drop",
  renew: "pool.renew",
  tick: "pool.tick",
} as const;

export type PoolTake = { placement: Placement; size: string; computer: string; org?: string };

/** The usage subjects cloud computers are metered under (meter `computer`). */
export const SUBJECTS = {
  /** A size's VM seconds: `cloud/<size>`. */
  vm: (size: string) => `cloud/${size}`,
  /** Disks' and snapshots' GB-hours. */
  disk: "cloud/disk",
  snapshot: "cloud/snapshot",
} as const;
