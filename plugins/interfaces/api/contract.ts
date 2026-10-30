/**
 * The API plugin's contract: what other plugins and apps may import: the
 * shape of a developer key, of who calls with one, and of the presets its
 * front end offers (the `apiPresets` resource: what a new key does, in a
 * click). They reach the rest by name: its collection (`api_key`), queries
 * (`api_key.mine`) and Actions (`api_key.create`, `api_key.revoke`).
 *
 * ```ts
 * resources: {
 *   apiPresets: {
 *     notes: {
 *       title: "Notes",
 *       description: "Write and read this space's notes",
 *       actions: ["note.write"],
 *       queries: ["note.list"],
 *     },
 *   },
 * }
 * ```
 */
export type { ApiKey } from "./collections/key.ts";
export type { KeyActor } from "./shared/actor.ts";

/** An `apiPresets` resource: a ready-made set of what a key does. */
export type ApiPreset = {
  title: string;
  /** What a key made with it can do, in a line. */
  description: string;
  actions?: string[];
  queries?: string[];
  views?: string[];
  /** Lowest first. */
  order?: number;
};
