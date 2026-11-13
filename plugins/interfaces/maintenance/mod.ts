/**
 * Maintenance: HTTP endpoints for an app's operators, for when they can't
 * reach its database themselves (a client's network that keeps their
 * database user out). The one place an app runs SQL of its own.
 *
 * - **A key** (the `maintenance` resource's `key`, or several in `keys`
 *   while one rotates, from the app's environment): every request shows one
 *   (`Authorization: Bearer <key>`), compared in constant time. Without
 *   one, every request is unauthorized; a weak one stops the app. An orgs
 *   host's orgs don't get the plugin (one key would reach every org).
 * - **A line for each request**, before it runs (`log`): who, what (a
 *   statement's hash), which key, when: a record outside the database.
 * - **The maintenance actor** (`{ kind: "maintenance", id: "maintenance",
 *   by? }`): who every request acts as. Its Actions let only it call them,
 *   and run as the system on the record (`ctx.as()`: events say `via` it),
 *   so no rule keeps it from a document, and nothing else can act as it: a
 *   host binds actors, and none binds this one but these routes.
 * - **Read SQL**, one read-only statement (`runtime.maintenance.read`, the
 *   store's `inspect`): at most `limit` rows and `bytes`, cut off after
 *   `timeout`. On a PostgreSQL server, as a role of its own
 *   (`postgresStore({ maintenance: { url } })`), or, told so, as the
 *   store's own (`maintenance: { storeRole: true }`); the README's
 *   Maintenance says what each costs.
 * - **Writes through the owner**: the collections' operations (insertOne…
 *   deleteMany, and find…aggregate), checked against their schemas, recorded
 *   as events, cached and heard by Processors like any write; and the
 *   collections' named queries (`booking.stats`), read as the system.
 * - **Raw SQL writes, inside the owner** (`runtime.maintenance.write`), for
 *   what operations can't do: one statement, in line with the owner's
 *   writes, fenced by its epoch, with one `maintenance.sql` audit event in
 *   the same commit; the owner then forgets what it derived from documents.
 *   It bypasses schemas and per-document events.
 * - **Actions made for operators**, any plugin's whose `allow` lets the
 *   maintenance actor in (`isMaintenance`): a migration run again, or tried
 *   dry first, by its name and input.
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
import { serveMaintenance, settingsOf } from "./resources/routes.ts";

export * from "./contract.ts";
export { serveMaintenance } from "./resources/routes.ts";

export const maintenance: Plugin = definePlugin({
  name: "maintenance",
  actions: {
    "maintenance.read": readAction,
    "maintenance.write": writeAction,
  },
  routes: { "/maintenance/*": serveMaintenance },
  // A key too short to be safe stops the app from starting.
  check: ({ resources }) => void settingsOf(resources),
});

export default maintenance;
