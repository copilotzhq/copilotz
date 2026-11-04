/**
 * Maintenance: HTTP endpoints for an app's operators, for when they can't
 * reach its database themselves (a client's network that keeps their
 * database user out). The one place an app runs SQL of its own.
 *
 * - **One key** (the `maintenance` resource's `key`, from the app's
 *   environment): every request shows it (`Authorization: Bearer <key>`),
 *   compared in constant time. Without one, the endpoints answer that
 *   maintenance is off.
 * - **The maintenance actor** (`{ kind: "maintenance", id: "maintenance",
 *   by? }`): who every request acts as. Its Actions let only it call them,
 *   and run as the system on the record (`ctx.as()`: events say `via` it),
 *   so no rule keeps it from a document, and nothing else can act as it: a
 *   host binds actors, and none binds this one but these routes.
 * - **Read SQL**, one read-only statement (`runtime.maintenance.read`, the
 *   store's `inspect`): at most `limit` rows, cut off after `timeout`.
 * - **Writes through the owner**: the collections' operations (insertOne…
 *   deleteMany, and find…aggregate), checked against their schemas, recorded
 *   as events, cached and heard by Processors like any write.
 * - **Raw SQL writes, inside the owner** (`runtime.maintenance.write`), for
 *   what operations can't do: one statement, in line with the owner's
 *   writes, fenced by its epoch, with one `maintenance.sql` audit event in
 *   the same commit; the owner then forgets what it derived from documents.
 *   It bypasses schemas and per-document events.
 * - **Blobs by id**, as stored (in the store, or the app's Blobs).
 *
 * The endpoints are in `resources/routes.ts`; what raw SQL does to the
 * owner, in `runtime/maintain.ts`.
 *
 * ```ts
 * plugins: [...plugins, maintenance, definePlugin({
 *   name: "app",
 *   resources: { maintenance: { key: process.env.MAINTENANCE_KEY } },
 * })]
 * ```
 *
 * ```sh
 * curl -s https://app.example.com/maintenance/sql -H "authorization: Bearer $KEY" \
 *   -d '{"sql": "SELECT _id, text FROM message WHERE thread = $1", "params": ["t1"]}'
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { readAction } from "./actions/read.ts";
import { writeAction } from "./actions/write.ts";
import { route, settingsOf } from "./resources/routes.ts";

export * from "./contract.ts";
export { serveMaintenance } from "./resources/routes.ts";

export const maintenance: Plugin = definePlugin({
  name: "maintenance",
  actions: {
    "maintenance.read": readAction,
    "maintenance.write": writeAction,
  },
  resources: {
    routes: { maintenance: route },
  },
  // A key too short to be safe stops the app from starting.
  check: ({ resources }) => void settingsOf(resources),
});

export default maintenance;
