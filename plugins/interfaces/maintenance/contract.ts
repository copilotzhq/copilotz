/**
 * The maintenance plugin's contract: its settings (the `maintenance`
 * resource) and who its requests act as. Other plugins and apps reach the
 * rest by name: its Actions (`maintenance.read`, `maintenance.write`) and the
 * runtime's audit event of a SQL write (`maintenance.sql`). A plugin's own
 * Action for operators (a migration) lets them call it with `allow:
 * isMaintenance`: `POST /maintenance/actions/<action>`.
 *
 * ```ts
 * resources: { maintenance: { key: process.env.MAINTENANCE_KEY } }
 * ```
 */
import type { Actor } from "../../../runtime/mod.ts";

export type MaintenanceSettings = {
  /**
   * The secret requests show (`Authorization: Bearer <key>`): at least 32
   * random characters, from the app's environment. A key that is short, or
   * plainly not random (one character, a short pattern repeated), stops the
   * app from starting. Without any key, every request is unauthorized.
   */
  key?: string;
  /** More keys, any of which works: for rotating one (add the new, then remove the old). */
  keys?: string[];
  /** The most rows (or documents) a read answers with (default 1,000). */
  limit?: number;
  /** The longest a SQL statement may run, in ms (default 30,000). */
  timeout?: number;
  /** The most bytes an answer's rows take (default 8 MB): past it they're cut, and `truncated`. */
  bytes?: number;
  /**
   * Where a line for each request goes before it runs, so the record of it
   * is also outside the database its holder can write (default: a JSON line
   * on standard output, which hosts like Cloud Run keep).
   */
  log?: (line: MaintenanceLog) => void;
};

/** A request's line: who, what (a statement's hash, not its text), when. */
export type MaintenanceLog = {
  severity: "NOTICE";
  maintenance: string;
  by?: string;
  sql?: string;
  params?: number;
  collection?: string;
  op?: string;
  query?: string;
  /** An Action made for operators, by name. */
  action?: string;
  blob?: string;
  key?: number;
  at: string;
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
