/** Private owner-side snapshot control; never serialized to a worker. */
import type { SqlReadSnapshot, SqlSnapshotCleanup } from "../events/session.ts";
const control = Symbol("copilotz.snapshot.control");
export function withSnapshotControl<T extends object>(
  context: T,
  scope:
    | (SqlReadSnapshot & { cleanup?: Promise<SqlSnapshotCleanup> })
    | undefined,
): T {
  if (scope) Object.defineProperty(context, control, { value: scope });
  return context;
}
export function snapshotControl(
  context: object,
): (SqlReadSnapshot & { cleanup?: Promise<SqlSnapshotCleanup> }) | undefined {
  return (context as Record<
    symbol,
    (SqlReadSnapshot & { cleanup?: Promise<SqlSnapshotCleanup> }) | undefined
  >)[control];
}
