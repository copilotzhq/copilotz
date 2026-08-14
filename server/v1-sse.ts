import type { CopilotzApplication } from "../runtime/application/index.ts";
import type {
  AttachmentOutput,
  AttachmentStreamOutput,
} from "../runtime/attachments/index.ts";
import type { ContentRef, ResolvedContent } from "../runtime/content/index.ts";
import type {
  ConversationMessage,
  Participant,
} from "../runtime/domain/index.ts";
import type { CopilotzEvent } from "../runtime/events/index.ts";
import type { EventNativeSseProjector } from "./fetch.ts";

const DEFAULT_MAX_INLINE_CONTENT_BYTES = 256_000;

export type V1SseAssetHrefInput = Readonly<{
  assetId: string;
  namespace: string;
  request: Request;
}>;

export type CreateV1SseProjectorOptions = Readonly<{
  /** Binary and oversized content remains a reference. Defaults to asset://. */
  assetHref?: (input: V1SseAssetHrefInput) => string;
  /** Maximum text or JSON body materialized into one compatibility frame. */
  maxInlineContentBytes?: number;
  /** Preserve application-defined events that have no v1 core mapping. */
  unknown?: "passthrough" | "omit";
}>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function maxInlineBytes(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_INLINE_CONTENT_BYTES;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new TypeError("V1 SSE maxInlineContentBytes must be non-negative.");
  }
  return resolved;
}

function isStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  const payload = (output as { payload?: unknown }).payload;
  return output.type === "stream.output" && Boolean(payload) &&
    typeof (payload as { getReader?: unknown }).getReader === "function";
}

function legacySender(
  participant: Participant,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: participant.id,
    externalId: participant.externalId,
    type: participant.participantType === "human"
      ? "user"
      : participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
  });
}

function frame(
  event: CopilotzEvent,
  type: string,
  payload: unknown,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(event.durable ? { id: event.id } : {}),
    ...(event.threadId ? { threadId: event.threadId } : {}),
    type,
    payload,
    correlationId: event.correlationId,
    metadata: event.metadata,
    createdAt: event.createdAt,
  });
}

function assetHref(
  ref: ContentRef,
  namespace: string,
  request: Request,
  options: CreateV1SseProjectorOptions,
): string {
  return options.assetHref?.({ assetId: ref.assetId, namespace, request }) ??
    `asset://${ref.assetId}`;
}

function referencedPart(
  resolved: ResolvedContent,
  namespace: string,
  request: Request,
  options: CreateV1SseProjectorOptions,
): Readonly<Record<string, unknown>> {
  const ref = resolved.ref;
  const url = assetHref(ref, namespace, request, options);
  const type = ref.kind === "video" ? "file" : ref.kind;
  return Object.freeze({
    type,
    url,
    mimeType: ref.mediaType,
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.alt ? { alt: ref.alt } : {}),
    ...(ref.kind === "video" ? { mediaKind: "video" } : {}),
  });
}

function legacyPart(
  resolved: ResolvedContent,
  namespace: string,
  request: Request,
  options: CreateV1SseProjectorOptions,
  limit: number,
): string | Readonly<Record<string, unknown>> {
  if (resolved.bytes.byteLength > limit) {
    return referencedPart(resolved, namespace, request, options);
  }
  if (resolved.ref.kind === "text") {
    return Object.freeze({
      type: "text",
      text: resolved.text ?? new TextDecoder().decode(resolved.bytes),
    });
  }
  if (resolved.ref.kind === "json") {
    return Object.freeze({
      type: "json",
      value: resolved.value ??
        JSON.parse(new TextDecoder().decode(resolved.bytes)),
    });
  }
  return referencedPart(resolved, namespace, request, options);
}

async function legacyMessage(
  application: CopilotzApplication,
  message: ConversationMessage,
  request: Request,
  options: CreateV1SseProjectorOptions,
  limit: number,
): Promise<Readonly<Record<string, unknown>>> {
  const resolved = await application.content.resolver.getMany(
    message.content,
    { namespace: message.namespace },
  );
  const parts = resolved.map((part) =>
    legacyPart(part, message.namespace, request, options, limit)
  );
  const content = parts.length === 1 &&
      typeof parts[0] !== "string" &&
      parts[0].type === "text"
    ? parts[0].text
    : Object.freeze(parts);
  return Object.freeze({
    id: message.id,
    content,
    sender: legacySender(message.sender),
    targetQueue: message.recipientIds,
    thread: Object.freeze({ id: message.threadId }),
    metadata: message.metadata,
    createdAt: message.createdAt,
  });
}

function streamMetadata(
  output: AttachmentStreamOutput,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: output.type,
    streamId: output.streamId,
    participant: output.participant,
    mediaType: output.mediaType,
    ...(output.causationId ? { causationId: output.causationId } : {}),
    correlationId: output.correlationId,
    metadata: output.metadata,
  });
}

/**
 * Creates the explicit v1 SSE edge projection. Uppercase names stay out of the
 * event-native engine and canonical binary bodies remain asset references.
 */
export function createV1SseProjector(
  application: CopilotzApplication,
  options: CreateV1SseProjectorOptions = {},
): EventNativeSseProjector {
  const limit = maxInlineBytes(options.maxInlineContentBytes);
  return async (output, request) => {
    if (isStreamOutput(output)) return streamMetadata(output);
    const payload = record(output.payload);
    if (output.type === "text.delta" || output.type === "reasoning.delta") {
      const text = typeof payload.text === "string"
        ? payload.text
        : typeof payload.token === "string"
        ? payload.token
        : "";
      return frame(output, "TOKEN", {
        threadId: output.threadId ?? "",
        agent: record(payload.agent),
        token: text,
        isComplete: false,
        isReasoning: output.type === "reasoning.delta",
      });
    }
    if (output.type === "tool_call.delta") {
      return frame(output, "TOOL_CALL_DELTA", {
        threadId: output.threadId ?? "",
        ...payload,
      });
    }
    if (output.type === "tool_output.delta") {
      return frame(output, "TOOL_OUTPUT_DELTA", {
        threadId: output.threadId ?? "",
        ...payload,
      });
    }
    if (
      output.durable && output.subject?.type === "message" &&
      (output.type === "message.created" || output.type === "message.revised")
    ) {
      const message = await application.conversation.getMessage(
        output.namespace,
        output.subject.id,
      );
      if (!message) return null;
      return frame(
        output,
        "NEW_MESSAGE",
        await legacyMessage(application, message, request, options, limit),
      );
    }
    return options.unknown === "omit" ? null : output;
  };
}
