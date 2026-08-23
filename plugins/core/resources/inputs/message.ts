import type { CopilotzInputEnvelope } from "@copilotz/copilotz/application";
import { bytesToBase64, type ContentInput } from "@copilotz/copilotz/content";
import type { Participant, ParticipantInput } from "../../contracts.ts";
import type { EventVisibility } from "@copilotz/copilotz/events";

export const CORE_MESSAGE_INPUT_EVENT = "copilotz.core.message.input";

export type CoreThreadInput = Readonly<{
  id?: string;
  externalId?: string;
}>;

export type CoreMessageInput = Readonly<{
  thread: string | CoreThreadInput;
  participant: string | Participant | ParticipantInput;
  recipientIds?: readonly string[];
  content: ContentInput | readonly ContentInput[];
  id?: string;
  correlationId?: string;
  deduplicationId?: string;
  metadata?: Record<string, unknown>;
  visibility?: EventVisibility;
}>;

export type CoreMessageInputEnvelope = CopilotzInputEnvelope<
  typeof CORE_MESSAGE_INPUT_EVENT,
  CoreMessageInput
>;

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonSafeContentPart(value: unknown): unknown {
  const part = record(value);
  if (!part || typeof part.type !== "string" || !MEDIA_TYPES.has(part.type)) {
    return value;
  }
  if (!(part.bytes instanceof Uint8Array)) return value;
  const { bytes, ...rest } = part;
  return Object.freeze({
    ...rest,
    dataBase64: bytesToBase64(bytes),
  });
}

function jsonSafeContent(value: CoreMessageInput["content"]): unknown {
  return Array.isArray(value)
    ? Object.freeze(value.map(jsonSafeContentPart))
    : jsonSafeContentPart(value);
}

/** Typed Core input helper. Runtime treats the result as an opaque envelope. */
export function message(input: CoreMessageInput): CoreMessageInputEnvelope {
  const {
    correlationId,
    deduplicationId,
    content,
    metadata,
    visibility,
    ...payload
  } = input;
  return Object.freeze({
    type: CORE_MESSAGE_INPUT_EVENT,
    payload: Object.freeze({
      ...payload,
      content: jsonSafeContent(content),
      ...(metadata ? { metadata: structuredClone(metadata) } : {}),
      ...(visibility ? { visibility } : {}),
    }) as CoreMessageInput,
    ...(correlationId ? { correlationId } : {}),
    ...(deduplicationId ? { deduplicationId } : {}),
    ...(visibility ? { visibility } : {}),
  });
}

export type CoreInputHelpers = Readonly<{
  message: typeof message;
}>;

export const core: CoreInputHelpers = Object.freeze({
  message,
});
