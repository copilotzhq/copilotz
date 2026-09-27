import type {
  CollectionPredicate,
  CollectionRecord,
} from "@copilotz/copilotz/collections";
import type { LlmMessage } from "@copilotz/copilotz/llm";
import type { ConversationMessage } from "../contracts.ts";
import type { CoreProcessorContext } from "../runtime-context.ts";
import { buildLlmTranscript, type LlmTranscriptEntry } from "./transcript.ts";
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
    and: [
      // Keep the batch candidate set on the physical primary-key column so
      // PostgreSQL can use its id index before evaluating snapshot JSON.
      { field: "id", in: ids },
      {
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
      },
    ],
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

const BATCH_SIZE = 20;

type MessageCollection = NonNullable<
  CoreProcessorContext["collections"]["message"]
>;

type Snapshots = ReadonlyMap<string, ConversationMessage>;

type ToolResultMarker = Readonly<{ text: string; bytes: number }>;

/** Running total of resolved bytes against an optional caller budget. */
function byteBudget(limit: number | undefined) {
  let used = 0;
  return {
    remaining: () =>
      limit === undefined ? undefined : Math.max(0, limit - used),
    overflowBy: (bytes: number) =>
      createContentByteLimitError(used + bytes, limit!),
    add(bytes: number) {
      used += bytes;
      if (limit !== undefined && used > limit) {
        throw createContentByteLimitError(used, limit);
      }
    },
  };
}

function recordBytes(record: CollectionRecord, withReasoning: boolean): number {
  const metadata = record.metadata as Record<string, unknown> | undefined;
  return bodyBytes(record.content) +
    (withReasoning
      ? bodyBytes(metadata?.llmReasoning) +
        bodyBytes(nativeReasoningBlocks(metadata?.llmNativeReasoning))
      : 0);
}

/**
 * Reads stored references and Asset sizes, without opening any body, and
 * returns a placeholder for each tool result over the inline limit.
 */
async function oversizedToolResultMarkers(
  context: CoreProcessorContext,
  messages: MessageCollection,
  threadId: string,
  batchIds: readonly string[],
  snapshots: Snapshots,
  toolResultIds: ReadonlySet<string>,
  inlineLimit: number,
): Promise<ReadonlyMap<string, ToolResultMarker>> {
  const stored = await messages.list({
    where: { threadId },
    filter: snapshotFilter(batchIds, snapshots),
    limit: batchIds.length,
  });
  if (stored.length !== batchIds.length) {
    throw new Error("Message history is no longer available.");
  }
  const refsById = new Map(
    stored.filter((record) => toolResultIds.has(record.id)).map((record) => [
      record.id,
      contentRefs(record.content).filter((ref) => !excludedFromTranscript(ref)),
    ]),
  );
  const assetIds = [
    ...new Set([...refsById.values()].flat().map((ref) => ref.assetId)),
  ];
  const markers = new Map<string, ToolResultMarker>();
  if (!assetIds.length) return markers;
  const sizes = new Map(
    (await context.content.getMany(assetIds)).map((asset) => [
      asset.id,
      asset.byteLength,
    ]),
  );
  for (const [id, refs] of refsById) {
    const totalBytes = refs.reduce((total, ref) => {
      const size = sizes.get(ref.assetId);
      if (size === undefined) {
        throw new Error(`Tool result content '${ref.assetId}' is unavailable.`);
      }
      return total + size;
    }, 0);
    if (totalBytes > inlineLimit) {
      const text = toolResultMarker(id, totalBytes);
      markers.set(id, {
        text,
        bytes: new TextEncoder().encode(text).byteLength,
      });
    }
  }
  return markers;
}

async function loadBodies(
  messages: MessageCollection,
  threadId: string,
  ids: readonly string[],
  snapshots: Snapshots,
  withReasoning: boolean,
  budget: ReturnType<typeof byteBudget>,
): Promise<readonly CollectionRecord[]> {
  const remaining = budget.remaining();
  try {
    return await messages.list({
      where: { threadId },
      // Match the captured record before resolved-read can open any Body.
      filter: snapshotFilter(ids, snapshots),
      limit: BATCH_SIZE,
    }, {
      content: {
        ...(remaining === undefined ? {} : { byteLimit: remaining }),
        fields: withReasoning
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
    if (isContentByteLimitError(error) && remaining !== undefined) {
      throw budget.overflowBy(error.bytes);
    }
    throw error;
  }
}

function withBodies(
  message: LlmMessage,
  record: CollectionRecord | undefined,
  marker: ToolResultMarker | undefined,
  ownAssistant: boolean,
): LlmMessage {
  if (!record && !marker) {
    throw new Error("Message history is no longer available.");
  }
  const content = marker
    ? [{
      kind: "text" as const,
      role: "body",
      mediaType: "text/plain; charset=utf-8",
      value: marker.text,
    }]
    : record!.content as LlmMessage["content"];
  if (message.role !== "assistant" || !ownAssistant) {
    return { ...message, content } as LlmMessage;
  }
  const metadata = record!.metadata as ConversationMessage["metadata"];
  return {
    ...message,
    content,
    ...(Array.isArray(metadata.llmReasoning)
      ? { reasoning: metadata.llmReasoning as LlmMessage["content"] }
      : {}),
    ...(nativeReasoningBlocks(metadata.llmNativeReasoning)
      ? {
        nativeReasoning: metadata.llmNativeReasoning as Extract<
          LlmMessage,
          { role: "assistant" }
        >["nativeReasoning"],
      }
      : {}),
  };
}

/** Resolve only final model-facing messages, after participant and causal projection. */
export async function prepareLlmTranscript(
  context: CoreProcessorContext,
  input: Parameters<typeof buildLlmTranscript>[0],
  options: Readonly<{ byteLimit?: number }> = {},
): Promise<readonly LlmTranscriptEntry[]> {
  const messages = context.collections.message;
  if (!messages) throw new Error("Core requires the Message Collection.");
  const entries = buildLlmTranscript(input);
  const snapshots: Snapshots = new Map(
    input.history.map((message) => [message.id, message]),
  );
  const toolResultIds = new Set(
    entries.filter((entry) =>
      snapshots.get(entry.sourceId)?.sender.participantType === "tool"
    ).map((entry) => entry.sourceId),
  );
  // Only the speaking Agent may receive its opaque provider state or readable
  // reasoning. Peer assistant turns remain ordinary user-visible history.
  const ownAssistantIds = new Set(
    entries.filter((entry) =>
      entry.message.role === "assistant" &&
      snapshots.get(entry.sourceId)?.sender.id === input.participantId
    ).map((entry) => entry.sourceId),
  );
  const uniqueIds = [...new Set(entries.map((entry) => entry.sourceId))];
  const inlineLimit = toolResultLimit(context);
  const budget = byteBudget(options.byteLimit);
  const markers = new Map<string, ToolResultMarker>();
  const records = new Map<string, CollectionRecord>();

  for (const withReasoning of [false, true]) {
    const ids = uniqueIds.filter((id) =>
      ownAssistantIds.has(id) === withReasoning
    );
    for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
      const batchIds = ids.slice(offset, offset + BATCH_SIZE);
      if (batchIds.some((id) => toolResultIds.has(id))) {
        const found = await oversizedToolResultMarkers(
          context,
          messages,
          input.threadId,
          batchIds,
          snapshots,
          toolResultIds,
          inlineLimit,
        );
        for (const [id, marker] of found) markers.set(id, marker);
      }
      const bodyIds = batchIds.filter((id) => !markers.has(id));
      const loaded = bodyIds.length
        ? await loadBodies(
          messages,
          input.threadId,
          bodyIds,
          snapshots,
          withReasoning,
          budget,
        )
        : [];
      const markerBytes = batchIds.reduce(
        (total, id) => total + (markers.get(id)?.bytes ?? 0),
        0,
      );
      budget.add(
        loaded.reduce(
          (total, record) => total + recordBytes(record, withReasoning),
          0,
        ) + markerBytes,
      );
      for (const record of loaded) records.set(record.id, record);
    }
  }

  return entries.map(({ sourceId, message }) => ({
    sourceId,
    message: withBodies(
      message,
      records.get(sourceId),
      markers.get(sourceId),
      ownAssistantIds.has(sourceId),
    ),
  }));
}
