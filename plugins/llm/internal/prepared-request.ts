/** Pure conversion shared by preflight and durable Action execution. @module */
import { type ContentRef, formatAssetRef } from "@copilotz/copilotz/content";
import type {
  LlmAdapterContentPart,
  LlmAdapterMessage,
  LlmAdapterNativeReasoning,
  LlmAdapterRequest,
  LlmMessage,
  LlmRequest,
} from "./contracts.ts";
function contentFields(ref: ContentRef): Readonly<Record<string, unknown>> {
  return {
    role: ref.role,
    mediaType: ref.mediaType,
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.alt ? { alt: ref.alt } : {}),
    ...(ref.language ? { language: ref.language } : {}),
    ...(ref.disposition ? { disposition: ref.disposition } : {}),
    ...(ref.metadata ? { metadata: structuredClone(ref.metadata) } : {}),
  };
}

export type PreparedEntry = ContentRef & { value?: unknown; resolve?: false };

function preparedPart(ref: PreparedEntry): LlmAdapterContentPart {
  const fields = contentFields(ref);
  if (ref.kind === "text") {
    return {
      type: "text",
      text: ref.value as string,
      ...fields,
    } as LlmAdapterContentPart;
  }
  if (ref.kind === "json") {
    return {
      type: "json",
      value: structuredClone(ref.value),
      ...fields,
    } as LlmAdapterContentPart;
  }
  return {
    type: ref.kind,
    bytes: (ref.value as Uint8Array).slice(),
    ...fields,
  } as LlmAdapterContentPart;
}

/**
 * Attachment bodies remain application-owned. Adapters receive only this
 * provider-neutral notice, so an Agent can deliberately use an asset Tool
 * instead of silently inlining a potentially large or sensitive body.
 */
function attachmentPart(
  ref: ContentRef,
  namespace: string,
): LlmAdapterContentPart {
  const descriptor = JSON.stringify({
    name: ref.name ?? ref.assetId,
    mediaType: ref.mediaType,
    assetRef: formatAssetRef(namespace, ref.assetId),
  });
  return Object.freeze({
    type: "text",
    text:
      `Copilotz attachment ${descriptor}. Use an asset tool to retrieve or inspect this attachment; its body is not included in this LLM request.`,
    role: ref.role,
    mediaType: "text/plain; charset=utf-8",
    ...(ref.name ? { name: ref.name } : {}),
  }) as LlmAdapterContentPart;
}

function projectPreparedMessage(
  message: LlmMessage,
  namespace: string,
  replay?: Readonly<{ adapter: string; model: string; api?: string }>,
): LlmAdapterMessage {
  const content = Object.freeze(
    (message.content as readonly PreparedEntry[]).map((ref) =>
      ref.resolve === false ? attachmentPart(ref, namespace) : preparedPart(ref)
    ),
  );
  const common = {
    content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.metadata
      ? { metadata: structuredClone(message.metadata) }
      : {}),
  };
  if (message.role === "assistant") {
    const native = message.nativeReasoning;
    const nativeReasoning = native && replay &&
        native.adapter === replay.adapter && native.model === replay.model &&
        (replay.api === undefined || native.api === replay.api)
      ? (() => {
        const blocks = native.blocks.map((entry, index) => {
          const ref = entry as PreparedEntry;
          if (
            ref.kind !== "json" || ref.resolve === false ||
            !Object.hasOwn(ref, "value") ||
            !ref.value || typeof ref.value !== "object" ||
            Array.isArray(ref.value)
          ) {
            throw new TypeError(
              `LLM native reasoning block ${index} must be prepared JSON.`,
            );
          }
          return structuredClone(ref.value) as Record<string, unknown>;
        });
        return Object.freeze({
          schema: native.schema,
          adapter: native.adapter,
          api: native.api,
          model: native.model,
          blocks: Object.freeze(blocks),
        }) as LlmAdapterNativeReasoning;
      })()
      : undefined;
    return Object.freeze({
      role: message.role,
      ...common,
      ...(message.reasoning?.length
        ? {
          reasoning: message.reasoning.map((entry) => {
            const ref = entry as PreparedEntry;
            if (
              ref.kind !== "text" || typeof ref.value !== "string"
            ) {
              throw new TypeError("LLM reasoning must contain prepared text.");
            }
            return ref.value;
          }).join("\n"),
        }
        : {}),
      ...(message.toolCalls
        ? { toolCalls: structuredClone(message.toolCalls) }
        : {}),
      ...(message.toolPlanId ? { toolPlanId: message.toolPlanId } : {}),
      ...(nativeReasoning ? { nativeReasoning } : {}),
    });
  }
  if (message.role === "tool") {
    return Object.freeze({
      role: message.role,
      ...common,
      toolCallId: message.toolCallId,
      ...(message.toolPlanId ? { toolPlanId: message.toolPlanId } : {}),
    });
  }
  return Object.freeze({ role: message.role, ...common });
}

export function projectPreparedRequest(
  request: LlmRequest,
  namespace: string,
  replay?: Readonly<{ adapter: string; model: string; api?: string }>,
): LlmAdapterRequest {
  if (!request || !Array.isArray(request.messages)) {
    throw new TypeError("LLM request.messages must be an array.");
  }
  const messages = request.messages.map((message) =>
    projectPreparedMessage(message, namespace, replay)
  );
  return Object.freeze({
    messages: Object.freeze(messages),
    ...(request.tools
      ? { tools: Object.freeze(structuredClone(request.tools)) }
      : {}),
    ...(request.instructions !== undefined
      ? { instructions: request.instructions }
      : {}),
  });
}
