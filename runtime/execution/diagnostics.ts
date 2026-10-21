import type { EventDelivery } from "../events/types.ts";
import type {
  DeliveryDiagnostic,
  DeliveryDiagnosticError,
  DeliveryDiagnosticSink,
} from "./types.ts";

const MAX_NAME_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 500;
/** Bounds the text the masking patterns ever scan. */
const MAX_SCANNED_LENGTH = 2_000;

/**
 * Masks the credential shapes that most often end up in error text. This is a
 * best-effort courtesy: a Processor is not schema-marked, so the runtime
 * cannot know which values are secret, and no pattern list can be complete.
 */
const CREDENTIAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@"],
  // Authorization headers and bare bearer tokens.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "$1 [redacted]"],
  // key=value, "key": "value" and header-style credential fields.
  [
    /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|credentials?)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    "$1[redacted]",
  ],
  // JSON web tokens and well-known provider key prefixes.
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g, "[redacted]"],
  [
    /\b(?:sk|pk|rk|xox[abprs]|gh[pousr]|github_pat|AKIA|ASIA)[-_A-Za-z0-9]{16,}/g,
    "[redacted]",
  ],
];

/**
 * A failure as a diagnostic may carry it: the error's name and a bounded,
 * credential-masked message. Never its stack, cause, or extra properties, and
 * never the Event it was handling.
 */
export function summarizeDeliveryError(
  error: unknown,
): DeliveryDiagnosticError {
  let text: string;
  try {
    text = error instanceof Error
      ? String(error.message)
      : typeof error === "string"
      ? error
      : "A non-Error value was thrown.";
  } catch {
    text = "The error message could not be read.";
  }
  return summarizeError(error instanceof Error ? error.name : undefined, text);
}

function summarizeError(name: unknown, text: string): DeliveryDiagnosticError {
  const named = typeof name === "string" &&
      /^[A-Za-z_$][\w$.]*$/.test(name) && name.length <= MAX_NAME_LENGTH
    ? name
    : "Error";
  let message = text.slice(0, MAX_SCANNED_LENGTH);
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    message = message.replace(pattern, replacement);
  }
  message = message.trim() || named;
  if (message.length > MAX_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_MESSAGE_LENGTH)}…`;
  }
  return ({ name: named, message } as const);
}

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

/**
 * Writes one structured error line when a delivery dead-letters: its consumer
 * (the Processor or Action), operation, attempts, and the recorded error's
 * code, name and credential-masked message. Never the Event, its input, or a
 * stack. Logging cannot affect settlement.
 */
export function logDeadLetter(delivery: EventDelivery): void {
  try {
    const recorded = delivery.lastError ?? {};
    const code = recorded.code;
    console.error(JSON.stringify({
      severity: "ERROR",
      message: "[copilotz] Delivery dead-lettered",
      consumerId: delivery.consumerId,
      operationId: delivery.settlementScopeId,
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      databaseSchema: delivery.databaseSchema,
      attempts: delivery.attempts,
      maxAttempts: delivery.maxAttempts,
      error: {
        ...(typeof code === "string" && /^[\w.:-]{1,80}$/.test(code)
          ? { code }
          : {}),
        ...summarizeError(
          recorded.name,
          typeof recorded.message === "string" ? recorded.message : "",
        ),
      },
    }));
  } catch {
    // Logging is deliberately incapable of changing delivery settlement.
  }
}
