/**
 * Developer keys: what code calls the app with, as someone, over the
 * runtime's REST API (`/api/`) or its socket (see runtime/api.ts and
 * runtime/client.ts): `Authorization: Bearer <key>`.
 *
 * - **Keys** (`api_key`): a person makes one in a space they're in
 *   (`api_key.create`), for what it may use there (its `scope`: Actions,
 *   queries, Views, collections, by exact name), sees its secret once, and
 *   revokes it (`api_key.revoke`); each says when it was last used. A key is
 *   a member of its space (`key:<id>`), an editor when it may call or write,
 *   else a viewer, and shows among the space's members, where its managers
 *   revoke it too. Keys change only through these Actions, never directly.
 * - **A key acts as its person, in its space only:** every call it makes is
 *   theirs (`kind: "person"`, so `people` lets it in and `inPerson` keeps it
 *   out), reaching what both its membership and its person reach (the access
 *   plugin's rules). The runtime checks its scope where its calls come in,
 *   never inside them: an Action it may call does its work as usual.
 *   Everything it causes says which key (`actor.key`): the log tells it apart.
 * - **Who calls with a key** is the plugin's `who`: a request's
 *   `Authorization: Bearer <key>` is the key's person, with its scope, on
 *   every way in (the REST API, `/connect` for the socket).
 *
 * ```ts
 * plugins: [models, chat, ...access, api]            // the server
 * await web({ plugins: [webShell, chatWeb, spacesWeb, apiWeb], root }) // the browser
 * const app = await connect("https://app.example", { key }) // a script (runtime/client.ts)
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { revokeAction, usedAction } from "./actions/revoke.ts";
import { apiKey } from "./collections/key.ts";
import { keyWho } from "./shared/actor.ts";
import { rules } from "./shared/rules.ts";
import { leftProcessor } from "./processors/left.ts";

export * from "./contract.ts";

export const api: Plugin = definePlugin({
  name: "api",
  // Keys work in spaces.
  requires: ["spaces"],
  collections: { api_key: apiKey },
  actions: {
    "api_key.create": createAction,
    "api_key.revoke": revokeAction,
    "api_key.used": usedAction,
  },
  guard: rules,
  processors: { "api.left": leftProcessor },
  resources: {
    // A key's record lives in its space: read where the space is, changed by its managers.
    shared: { api_key: { write: "manage" } },
  },
  who: keyWho,
});

export default api;
