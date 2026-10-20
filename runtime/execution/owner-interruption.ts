/** Owner-private physical interruption classification; never a wire capability. */
const interruptions = new WeakSet<object>();
export function ownerExecutionInterrupted(): Error {
  const error = new Error("The worker placement was interrupted.");
  interruptions.add(error);
  return error;
}
export function isOwnerExecutionInterrupted(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    interruptions.has(error);
}
