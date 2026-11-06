/**
 * The API plugin's contract: what other plugins and apps may import: the
 * shape of a developer key, of who calls with one, of the presets its front
 * end offers (the `apiPresets` resource: what a new key may use, in a
 * click), and the role a scope gives a key. They reach the rest by name:
 * its collection (`api_key`), queries (`api_key.mine`, `api_key.actor`) and
 * Actions (`api_key.create`, `api_key.revoke`).
 *
 * ```ts
 * resources: {
 *   apiPresets: {
 *     notes: {
 *       title: "Notes",
 *       description: "Write and read this space's notes",
 *       scope: { call: ["note.write"], query: ["note.list"], read: ["note"] },
 *     },
 *   },
 * }
 * ```
 */
import type { Scope } from "../../../runtime/mod.ts";

export type { ApiKey } from "./collections/key.ts";
export { type KeyActor, roleOf } from "./shared/actor.ts";

/** An `apiPresets` resource: a ready-made scope for a key; its role follows from it. */
export type ApiPreset = {
  title: string;
  /** What a key made with it can do, in a line. */
  description: string;
  /** What it may use: Actions, queries, Views, and collections it reads and writes directly. */
  scope: Scope;
  /** Lowest first. */
  order?: number;
};
