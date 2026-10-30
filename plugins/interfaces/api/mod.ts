/**
 * The developer API: code calls the app with a key, over HTTP under `/api/`
 * (see shared/server.ts): it calls Actions and runs queries by name, reads
 * Views, and follows what happens, as server-sent events.
 *
 * - **Keys** (`api_key`): a person makes one in a space they're in
 *   (`api_key.create`), for what it may do there (Actions, queries and
 *   Views, by name), sees its secret once, and revokes it
 *   (`api_key.revoke`); each says when it was last used.
 * - **A key acts as its person, in its space only:** every call it makes is
 *   theirs, under the access plugin's rules, and these rules (its `guard`)
 *   keep its work, and its agents' turns, to that space. Everything it
 *   causes says which key (`actor.key`): the log tells it apart.
 * - **The HTTP** is a `routes` resource of the web host (a `serve` route
 *   at `/api/`), which hands it the runtime: Actions by call id, their
 *   `allow`, the reference from `describe()`, events as they commit.
 *
 * ```ts
 * plugins: [models, chat, ...access, api]            // the server
 * await web({ plugins: [webShell, chatWeb, spacesWeb, apiWeb], root }) // the browser
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { revokeAction, usedAction } from "./actions/revoke.ts";
import { apiKey } from "./collections/key.ts";
import { rules } from "./shared/rules.ts";
import { serveApi } from "./shared/server.ts";

export * from "./contract.ts";
export { serveApi, type Served } from "./shared/server.ts";

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
  resources: {
    routes: { api: { path: "/api/", serve: serveApi } },
  },
});

export default api;
