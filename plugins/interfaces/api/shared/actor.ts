/**
 * Who calls with a key: its person (`kind: "person"`, so what lets people in
 * lets it in, and what only a person decides, `inPerson`, keeps it out),
 * with which key (`key`, its id: the start of its secret's hash) and what it
 * may use (`scope`, which the runtime checks where a call comes in). Where it
 * reaches is its own membership, `key:<id>` in its space, within what its
 * person reaches (the access plugin's `reachOf`). The log tells a key's work
 * from its person's own by `key`.
 *
 * The plugin's `who` (`keyWho`) says it: a request's `Authorization: Bearer
 * <key>` is its key's actor (`api_key.actor`), on any of the runtime's ways in
 * (the API's route, `/connect` for the socket).
 */
import type { Actor, Scope, Who } from "../../../../runtime/mod.ts";

export type KeyActor = { kind: "person"; id: string; key: string; scope: Scope };

/** Whether an actor calls with a key: a person's, by its id. */
export const isKey = (actor: Actor | undefined): boolean =>
  actor?.kind === "person" && typeof actor.key === "string";

/** What a key may do in its space, from what it may use: any call or write makes it an editor. */
export const roleOf = (scope: Scope): "editor" | "viewer" =>
  scope.call?.length || scope.write?.length ? "editor" : "viewer";

/** The secret a request shows as its key (`Authorization: Bearer <key>`); undefined for none. */
export function bearerOf(request: Request): string | undefined {
  const [scheme, secret] = (request.headers.get("authorization") ?? "").split(/\s+/, 2);
  return scheme?.toLowerCase() === "bearer" && secret ? secret : undefined;
}

/** Who a request is by its key: the key's person, with its key and scope; nothing without one. */
export const keyWho: Who = (request, { query }) => {
  const secret = bearerOf(request);
  return secret ? query<KeyActor | null>("api_key.actor", { secret }) : null;
};
