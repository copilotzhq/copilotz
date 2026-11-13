/**
 * The computer program's pool mode (`computer pool`, program/pool.ts), as an
 * app that hosts computers drives it: a VM runs the program as a free VM of
 * the app's pool, connected as a worker of the `pool` kind (its id the VM's
 * name), until the app gives it a computer to serve, for one wake. The app's
 * side (its pools, disks and VMs) is the app's own; this is what the two
 * agree on. Plain types and names only.
 */

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
