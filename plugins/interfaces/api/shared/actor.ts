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
 * (its REST API, `/connect` for the socket, plugins' routes). Each use is
 * noted on the key (`used`), at most once a minute.
 */
import type { Actor, Resources, Scope, Who } from "../../../../runtime/mod.ts";

export type KeyActor = { kind: "person"; id: string; key: string; scope: Scope; in: string };

/** A key's last use is noted at most this often. */
const USED_EVERY_MS = 60_000;

/** When each key's use was last noted, by runtime (its resources): at most once a minute each. */
const noted = new WeakMap<Resources, Map<string, number>>();

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
export const keyWho: Who = async (request, { query, call, resources }) => {
  const secret = bearerOf(request);
  if (!secret) return null;
  const actor = await query<KeyActor | null>("api_key.actor", { secret });
  if (actor) used(resources, call, actor.key);
  return actor;
};

/** Notes a key's use, at most once a minute, without waiting for it. */
function used(
  resources: Resources,
  call: (action: string, input?: unknown) => Promise<unknown>,
  key: string,
) {
  let last = noted.get(resources);
  if (!last) noted.set(resources, last = new Map());
  const now = Date.now();
  if (now - (last.get(key) ?? 0) < USED_EVERY_MS) return;
  last.set(key, now);
  void call("api_key.used", { key, at: new Date(now).toISOString() }).catch(() => {});
}
