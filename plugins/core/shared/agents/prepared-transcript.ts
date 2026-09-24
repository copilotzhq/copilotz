import type {
  CollectionPredicate,
  CollectionRecord,
} from "@copilotz/copilotz/collections";
import type { LlmMessage } from "@copilotz/copilotz/llm";
import type { ConversationMessage } from "../contracts.ts";
import type { CoreProcessorContext } from "../runtime-context.ts";
import { buildLlmTranscript } from "./transcript.ts";
import type { ContentRef } from "@copilotz/copilotz/content";
import {
  createContentByteLimitError,
  isContentByteLimitError,
} from "@copilotz/copilotz/content";

function bodyBytes(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, entry) => {
    if (!entry || typeof entry !== "object" || !("value" in entry)) {
      return total;
    }
    const body = entry.value;
    return total +
      (body instanceof Uint8Array ? body.byteLength : new TextEncoder().encode(
        typeof body === "string" ? body : JSON.stringify(body) ?? "",
      ).byteLength);
  }, 0);
}

const DEFAULT_TOOL_RESULT_INLINE_BYTES = 10 * 1024;
const MIN_TOOL_RESULT_INLINE_BYTES = 2 * 1024;

function contentRefs(value: unknown): ContentRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ContentRef =>
    Boolean(entry) && typeof entry === "object" &&
    typeof (entry as Record<string, unknown>).assetId === "string" &&
    typeof (entry as Record<string, unknown>).kind === "string"
  );
}

function excludedFromTranscript(ref: ContentRef): boolean {
  return ref.disposition === "attachment" ||
    (ref.kind === "file" && ref.disposition == null);
}

function toolResultLimit(context: CoreProcessorContext): number {
  const configured = context.resources?.toolResults?.default as
    | { maxInlineBytes?: unknown }
    | undefined;
  const value = configured?.maxInlineBytes;
  if (value === undefined) return DEFAULT_TOOL_RESULT_INLINE_BYTES;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < MIN_TOOL_RESULT_INLINE_BYTES
  ) {
    throw new RangeError(
      `Core toolResults.default.maxInlineBytes must be at least ${MIN_TOOL_RESULT_INLINE_BYTES}.`,
    );
  }
  return value;
}

function toolResultMarker(messageId: string, bytes: number): string {
  return `[Tool result ${
    JSON.stringify(messageId)
  } has ${bytes} source bytes, so its body was omitted from this input. The full stored result remains retrievable by Message ID through bounded readToolResult calls (subject to Core's maxSourceBytes policy). Call readToolResult({messageId:${
    JSON.stringify(messageId)
  },offset:0,limit:8192}); offsets use its assembled UTF-8 text representation, reported as totalBytes. Use its search option for plain literal text.]`;
}

function snapshotFilter(
  ids: readonly string[],
  snapshots: ReadonlyMap<string, ConversationMessage>,
): CollectionPredicate {
  return {
    or: ids.flatMap((id) => {
      const snapshot = snapshots.get(id);
      return snapshot
        ? [{
          and: [
            { field: "id", eq: id },
            { field: "senderId", eq: snapshot.sender.id },
            { field: "createdAt", eq: snapshot.createdAt },
            { field: "updatedAt", eq: snapshot.updatedAt },
            {
              field: "content",
              jsonEquals: contentReferences(snapshot.content),
            },
            {
              field: "metadata",
              jsonEquals: snapshotMetadata(snapshot.metadata),
            },
            optionalSnapshotFilter(snapshot, "visibility"),
            optionalSnapshotFilter(snapshot, "revision"),
          ],
        }]
        : [];
    }),
  };
}

function contentReferences(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const { value: _value, resolve: _resolve, ...reference } = entry as Record<
      string,
      unknown
    >;
    return reference;
  });
}

function nativeReasoningBlocks(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const blocks = (value as Record<string, unknown>).blocks;
  return Array.isArray(blocks) ? blocks : undefined;
}

/** Resolved reasoning bodies are not part of the persisted message snapshot. */
function snapshotMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { llmReasoning, llmNativeReasoning, ...metadata } = value as Record<
    string,
    unknown
  >;
  const nativeBlocks = nativeReasoningBlocks(llmNativeReasoning);
  return llmReasoning === undefined && llmNativeReasoning === undefined
    ? metadata
    : {
      ...metadata,
      ...(llmReasoning === undefined
        ? {}
        : { llmReasoning: contentReferences(llmReasoning) }),
      ...(llmNativeReasoning === undefined ? {} : {
        llmNativeReasoning: nativeBlocks
          ? {
            ...(llmNativeReasoning as Record<string, unknown>),
            blocks: contentReferences(nativeBlocks),
          }
          : llmNativeReasoning,
      }),
    };
}

function optionalSnapshotFilter(
  snapshot: { visibility?: unknown; revision?: unknown },
  field: "visibility" | "revision",
) {
  return Object.hasOwn(snapshot, field)
    ? { field, jsonEquals: snapshot[field] }
    : { field, exists: false };
}

/** Resolve only final model-facing messages, after participant and causal projection. */
export async function prepareLlmTranscript(
  context: CoreProcessorContext,
  input: Parameters<typeof buildLlmTranscript>[0],
  options: Readonly<{ byteLimit?: number }> = {},
): Promise<readonly LlmMessage[]> {
  const sources: string[] = [];
  const transcript = buildLlmTranscript(input, (id) => sources.push(id));
  const snapshots = new Map(
    input.history.map((message) => [message.id, message]),
  );
  const toolResultSources = new Set(
    sources.filter((id) =>
      snapshots.get(id)?.sender.participantType === "tool"
    ),
  );
  // Only the speaking Agent may receive its opaque provider state or readable
  // reasoning. Peer assistant turns remain ordinary user-visible history.
  const ownAssistantSources = new Set(
    sources.filter((id, index) =>
      transcript[index].role === "assistant" &&
      snapshots.get(id)?.sender.id === input.participantId
    ),
  );
  const resolved = new Map<string, CollectionRecord>();
  const toolMarkers = new Map<
    string,
    Readonly<{ text: string; bytes: number }>
  >();
  const messages = context.collections.message;
  if (!messages) throw new Error("Core requires the Message Collection.");
  let usedBytes = 0;
  const inlineLimit = toolResultLimit(context);
  for (const reasoning of [false, true]) {
    const ids = [...new Set(sources)].filter((id) =>
      ownAssistantSources.has(id) === reasoning
    );
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batchIds = ids.slice(offset, offset + 20);
      const hasToolResults = batchIds.some((id) => toolResultSources.has(id));
      if (hasToolResults) {
        // Read canonical references first. This lets Core inspect Asset
        // metadata and choose bounded placeholders before any body is opened.
        const snapshotsInStore = await messages.list({
          where: { threadId: input.threadId },
          filter: snapshotFilter(batchIds, snapshots),
          limit: batchIds.length,
        });
        if (snapshotsInStore.length !== batchIds.length) {
          throw new Error("Message history is no longer available.");
        }
        const storedById = new Map(
          snapshotsInStore.map((record) => [record.id, record]),
        );
        const resultRefs = batchIds.flatMap((id) => {
          if (!toolResultSources.has(id)) return [];
          const record = storedById.get(id);
          if (!record) return [];
          return contentRefs(record.content).filter((ref) =>
            !excludedFromTranscript(ref)
          );
        });
        if (resultRefs.length) {
          const assetRecords = await context.content.getMany([
            ...new Set(resultRefs.map((ref) => ref.assetId)),
          ]);
          const byteLengths = new Map(
            assetRecords.map((asset) => [asset.id, asset.byteLength]),
          );
          for (const id of batchIds) {
            if (!toolResultSources.has(id)) continue;
            const stored = storedById.get(id);
            if (!stored) continue;
            const refs = contentRefs(stored.content).filter((ref) =>
              !excludedFromTranscript(ref)
            );
            const totalBytes = refs.reduce((total, ref) => {
              const size = byteLengths.get(ref.assetId);
              if (size === undefined) {
                throw new Error(
                  `Tool result content '${ref.assetId}' is unavailable.`,
                );
              }
              return total + size;
            }, 0);
            if (totalBytes > inlineLimit) {
              const text = toolResultMarker(id, totalBytes);
              toolMarkers.set(id, {
                text,
                bytes: new TextEncoder().encode(text).byteLength,
              });
            }
          }
        }
      }

      const resolveIds = batchIds.filter((id) => !toolMarkers.has(id));
      if (!resolveIds.length) {
        for (const id of batchIds) {
          const marker = toolMarkers.get(id);
          if (marker) usedBytes += marker.bytes;
        }
        if (options.byteLimit !== undefined && usedBytes > options.byteLimit) {
          throw createContentByteLimitError(usedBytes, options.byteLimit);
        }
        continue;
      }

      let records: readonly CollectionRecord[];
      try {
        records = await messages.list({
          where: { threadId: input.threadId },
          // Match the captured record before resolved-read can open any Body.
          filter: {
            ...snapshotFilter(resolveIds, snapshots),
          },
          limit: 20,
        }, {
          content: {
            ...(options.byteLimit === undefined
              ? {}
              : { byteLimit: Math.max(0, options.byteLimit - usedBytes) }),
            fields: reasoning
              ? [
                "content",
                "metadata.llmReasoning",
                "metadata.llmNativeReasoning.blocks",
              ]
              : ["content"],
            exclude: [{ disposition: "attachment" }, {
              kind: "file",
              disposition: null,
            }],
          },
        });
      } catch (error) {
        if (
          isContentByteLimitError(error) &&
          options.byteLimit !== undefined
        ) {
          throw createContentByteLimitError(
            usedBytes + error.bytes,
            options.byteLimit,
          );
        }
        throw error;
      }
      usedBytes += records.reduce(
        (total, record) =>
          total + bodyBytes(record.content) +
          (reasoning
            ? bodyBytes(
              (record.metadata as Record<string, unknown>)?.llmReasoning,
            )
            : 0) +
          (reasoning
            ? bodyBytes(nativeReasoningBlocks(
              (record.metadata as Record<string, unknown>)?.llmNativeReasoning,
            ))
            : 0),
        0,
      );
      for (const id of batchIds) {
        const marker = toolMarkers.get(id);
        if (marker) usedBytes += marker.bytes;
      }
      if (options.byteLimit !== undefined && usedBytes > options.byteLimit) {
        throw createContentByteLimitError(usedBytes, options.byteLimit);
      }
      for (const record of records) resolved.set(record.id, record);
    }
  }
  return (transcript.map((message, index) => {
    const sourceId = sources[index];
    const record = resolved.get(sourceId);
    const marker = toolMarkers.get(sourceId);
    if (!record && !marker) {
      throw new Error("Message history is no longer available.");
    }
    const common = {
      ...message,
      content: marker
        ? [{
          kind: "text" as const,
          role: "body",
          mediaType: "text/plain; charset=utf-8",
          value: marker.text,
        }]
        : record!.content as LlmMessage["content"],
    };
    if (common.role !== "assistant") return common;
    const metadata = record!.metadata as ConversationMessage["metadata"];
    return {
      ...common,
      ...(ownAssistantSources.has(sources[index]) &&
          Array.isArray(metadata.llmReasoning)
        ? { reasoning: metadata.llmReasoning as LlmMessage["content"] }
        : {}),
      ...(ownAssistantSources.has(sources[index]) &&
          nativeReasoningBlocks(metadata.llmNativeReasoning)
        ? {
          nativeReasoning: metadata.llmNativeReasoning as Extract<
            LlmMessage,
            { role: "assistant" }
          >["nativeReasoning"],
        }
        : {}),
    };
  }));
}
