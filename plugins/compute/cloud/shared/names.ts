/**
 * What the cloud calls a computer's things, from its id: lowercase, starting
 * with a letter, at most 63 characters (valid Compute Engine names).
 */

const plain = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]/g, "-");

/** Its disk. */
export const diskOf = (computer: string) => `cz-d-${plain(computer)}`.slice(0, 63);

/** What its disk is attached as, on the VM serving it. */
export const deviceOf = (computer: string) => `cz-${plain(computer)}`.slice(0, 63);

/** A snapshot of its disk, taken at `at` (to the minute). */
export const snapshotOf = (computer: string, at: string) =>
  `cz-s-${plain(computer)}`.slice(0, 50) + `-${at.replace(/\D/g, "").slice(0, 12)}`;
