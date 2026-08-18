import type { CopilotzEvent, DurableEventDraft } from "../events/types.ts";
import type { Processor, ProcessorMatchClause } from "./processor.ts";

export type ProcessorMatchInput = DurableEventDraft | CopilotzEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMediaTypePattern(value: string): boolean {
  return /^[A-Za-z0-9!#$&^_.+-]+\/(\*|[A-Za-z0-9!#$&^_.+-]+)$/.test(value);
}

function mediaTypeMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== "string") return false;
  if (expected.endsWith("/*")) {
    return actual.slice(0, expected.length - 1) === expected.slice(0, -1);
  }
  return actual === expected;
}

/** Partial structural equality. String values that look like media types
 * (`type/subtype` or `type/*`) match the same way. */
export function matchesPartial(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected === "string" && isMediaTypePattern(expected)) {
    return mediaTypeMatches(expected, actual);
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.every((item, index) => matchesPartial(item, actual[index]));
  }
  if (!isRecord(expected)) return false;
  if (!isRecord(actual)) return false;
  return Object.entries(expected).every(([key, value]) =>
    matchesPartial(value, actual[key])
  );
}

export function matchDataFromPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  const ref = payload.dataRef;
  if (
    isRecord(ref) && typeof ref.assetId === "string" && ref.assetId.trim() &&
    Object.keys(payload).length === 1
  ) {
    return undefined;
  }
  return payload;
}

export function matchProcessor(
  processor: Processor,
  event: ProcessorMatchInput,
  data?: unknown,
): boolean {
  const resolved = data !== undefined ? data : matchDataFromPayload(
    "payload" in event ? event.payload : undefined,
  );
  return processor.on.some((clause) => matchesClause(clause, event, resolved));
}

function matchesClause(
  clause: ProcessorMatchClause,
  event: ProcessorMatchInput,
  data: unknown,
): boolean {
  if (clause.eventType !== event.type) return false;
  if (
    clause.namespace !== undefined &&
    !matchesPartial(clause.namespace, event.namespace)
  ) {
    return false;
  }
  if (
    clause.threadId !== undefined &&
    !matchesPartial(clause.threadId, event.threadId)
  ) {
    return false;
  }
  if (
    clause.subject !== undefined &&
    !matchesPartial(
      clause.subject,
      "subject" in event ? event.subject : undefined,
    )
  ) {
    return false;
  }
  if (
    clause.routing !== undefined &&
    !matchesPartial(clause.routing, event.routing ?? {})
  ) {
    return false;
  }
  if (
    clause.visibility !== undefined &&
    !matchesPartial(clause.visibility, event.visibility ?? {})
  ) {
    return false;
  }
  if (
    clause.metadata !== undefined &&
    !matchesPartial(clause.metadata, event.metadata ?? {})
  ) {
    return false;
  }
  if (clause.data !== undefined && !matchesPartial(clause.data, data)) {
    return false;
  }
  return true;
}
