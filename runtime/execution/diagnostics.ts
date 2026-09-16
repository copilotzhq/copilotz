import type { DeliveryDiagnostic, DeliveryDiagnosticSink } from "./types.ts";

/** Reports diagnostics best-effort; observations can never affect delivery. */
export function reportDeliveryDiagnostic(
  sink: DeliveryDiagnosticSink | undefined,
  diagnostic: DeliveryDiagnostic,
): void {
  if (!sink) return;
  try {
    const result = sink(diagnostic);
    if (result && typeof (result as Promise<void>).then === "function") {
      void Promise.resolve(result).catch(() => undefined);
    }
  } catch {
    // Diagnostics are deliberately incapable of changing runtime behavior.
  }
}
