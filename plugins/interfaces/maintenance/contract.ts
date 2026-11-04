/**
 * The maintenance plugin's contract: its settings (the `maintenance`
 * resource) and who its requests act as. Other plugins and apps reach the
 * rest by name: its Actions (`maintenance.read`, `maintenance.write`) and the
 * runtime's audit event of a SQL write (`maintenance.sql`).
 *
 * ```ts
 * resources: { maintenance: { key: process.env.MAINTENANCE_KEY } }
 * ```
 */
import type { Actor } from "../../../runtime/mod.ts";

export type MaintenanceSettings = {
  /**
   * The one secret requests show (`Authorization: Bearer <key>`): at least
   * 32 random characters, from the app's environment. Without it, the
   * endpoints answer that maintenance is off.
   */
  key?: string;
  /** The most rows (or documents) a read answers with (default 1,000). */
  limit?: number;
  /** The longest a SQL statement may run, in ms (default 30,000; PostgreSQL servers only). */
  timeout?: number;
};

/**
 * Who a maintenance request acts as: the key's holder. `by` is whoever the
 * request says sent it (`X-Maintenance-By`), recorded as said: anyone with
 * the key can claim any name.
 */
export type MaintenanceActor = { kind: "maintenance"; id: "maintenance"; by?: string };

/** Whether an actor is the maintenance key's. */
export const isMaintenance = (actor: Actor | undefined): actor is MaintenanceActor =>
  actor?.kind === "maintenance";
