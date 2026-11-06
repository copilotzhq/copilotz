/**
 * Who calls with a key: its person (`kind: "person"`, so what lets people in
 * lets it in, and what only a person decides, `inPerson`, keeps it out),
 * with which key (`key`, its id: the start of its secret's hash) and what it
 * may use (`scope`, which the runtime checks where a call comes in). Where it
 * reaches is its own membership, `key:<id>` in its space, within what its
 * person reaches (the access plugin's `reachOf`). The log tells a key's work
 * from its person's own by `key`.
 */
import type { Actor, Scope } from "../../../../runtime/mod.ts";

export type KeyActor = { kind: "person"; id: string; key: string; scope: Scope };

/** Whether an actor calls with a key: a person's, by its id. */
export const isKey = (actor: Actor | undefined): boolean =>
  actor?.kind === "person" && typeof actor.key === "string";

/** What a key may do in its space, from what it may use: any call or write makes it an editor. */
export const roleOf = (scope: Scope): "editor" | "viewer" =>
  scope.call?.length || scope.write?.length ? "editor" : "viewer";
