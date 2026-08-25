/**
 * Provides cancellation normalization shared by Web Tool Actions.
 *
 * @module
 */

export function actionAbortError(signal: AbortSignal): DOMException {
  if (
    signal.reason instanceof DOMException && signal.reason.name === "AbortError"
  ) {
    return signal.reason;
  }
  return new DOMException(
    signal.reason instanceof Error ? signal.reason.message : "Action cancelled",
    "AbortError",
  );
}
