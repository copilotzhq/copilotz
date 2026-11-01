/**
 * Who calls with a key: its person, limited to the key's space (`within`,
 * which reach respects: the access plugin's `reachOf`). `key` says which key (the
 * start of its hash, as the identity plugin's keys say it), so the log tells
 * a key's work from its person's own.
 */
import type { Actor } from "../../../../runtime/mod.ts";

export type KeyActor = { kind: "person"; id: string; key: string; within: string };

/** Whether an actor calls with one of these keys. */
export const isKey = (actor: Actor | undefined): actor is KeyActor =>
  actor?.kind === "person" && typeof actor.key === "string" && typeof actor.within === "string";
