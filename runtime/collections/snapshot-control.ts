/** Private owner-side snapshot control; never serialized to a worker. */
import type { SqlReadSnapshot, SqlSnapshotCleanup } from "../events/session.ts";
export type SnapshotControl = SqlReadSnapshot & {
  cleanup: Promise<SqlSnapshotCleanup>;
};
const control = Symbol("copilotz.snapshot.control");
export function withSnapshotControl<T extends object>(
  context: T,
  scope: SnapshotControl | undefined,
): T {
  if (scope) Object.defineProperty(context, control, { value: scope });
  return context;
}
export function snapshotControl(
  context: object,
): SnapshotControl | undefined {
  return (context as { [control]?: SnapshotControl })[control];
}
