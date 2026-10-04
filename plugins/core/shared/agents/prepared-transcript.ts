import type {
  CollectionPredicate,
  CollectionRecord,
} from "@copilotz/copilotz/collections";
import type { LlmMessage } from "@copilotz/copilotz/llm";
import type { ConversationMessage } from "../contracts.ts";
import type { CoreProcessorContext } from "../runtime-context.ts";
import {
  buildLlmTranscript,
  type LlmTranscriptEntry,
  peerToolStatusContent,
} from "./transcript.ts";
import type {
  ContentInput,
  ContentRef,
  ResolvedContent,
} from "@copilotz/copilotz/content";
import {
  type ContentValue,
  createContentByteLimitError,
  isContentRef,
  resolveContentInputs,
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

/** Running total of stored content bytes against an optional caller budget. */
function byteBudget(limit: number | undefined) {
  let used = 0;
  return {
    add(bytes: number) {
      used += bytes;
      if (limit !== undefined && used > limit) {
        throw createContentByteLimitError(used, limit);
      }
    },
  };
}

/**
 * The reference lists of a stored message that a prompt may open: its body,
 * and for the speaking Agent its readable and provider-native reasoning.
 * Entries are replaced in place once resolved.
 */
function referenceLists(
  record: CollectionRecord,
  ownAssistant: boolean,
): unknown[][] {
  const metadata = record.metadata as Record<string, unknown> | undefined;
  const nativeBlocks = nativeReasoningBlocks(metadata?.llmNativeReasoning);
  return [
    record.content,
    ...(ownAssistant ? [metadata?.llmReasoning, nativeBlocks] : []),
  ].filter((list): list is unknown[] => Array.isArray(list));
}

function referencesIn(lists: readonly unknown[][]): ContentRef[] {
  return lists.flat().map((entry) => {
    if (!isContentRef(entry)) {
      throw new TypeError("Invalid content reference in message history.");
    }
    return entry;
  }).filter((ref) => !excludedFromTranscript(ref));
}

const uniqueAssetIds = (refs: readonly ContentRef[]) => [
  ...new Set(refs.map((ref) => ref.assetId)),
];

/** Reads the stored messages, one statement per batch, exactly as captured. */
async function loadStored(
  messages: MessageCollection,
  threadId: string,
  ids: readonly string[],
  snapshots: Snapshots,
): Promise<ReadonlyMap<string, CollectionRecord>> {
  const stored = new Map<string, CollectionRecord>();
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const batchIds = ids.slice(offset, offset + BATCH_SIZE);
    const records = await messages.list({
      where: { threadId },
      // Match the captured record before any Body is opened.
      filter: snapshotFilter(batchIds, snapshots),
      limit: batchIds.length,
    });
    if (records.length !== batchIds.length) {
      throw new Error("Message history is no longer available.");
    }
    for (const record of records) stored.set(record.id, record);
  }
  return stored;
}

function textBody(value: string) {
  return {
    kind: "text" as const,
    role: "body",
    mediaType: "text/plain; charset=utf-8",
    value,
  };
}

function withBodies(
  entry: LlmTranscriptEntry,
  record: CollectionRecord | undefined,
  marker: ToolResultMarker | undefined,
  ownAssistant: boolean,
): LlmMessage {
  const { message, peerToolStatus } = entry;
  if (peerToolStatus && !peerToolStatus.showsOutput) return message;
  if (!record && !marker) {
    throw new Error("Message history is no longer available.");
  }
  const body = marker
    ? [textBody(marker.text)]
    : record!.content as LlmMessage["content"];
  const content = peerToolStatus
    ? peerToolStatusContent(peerToolStatus, body)
    : body;
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
async function prepareTranscript(
  context: CoreProcessorContext,
  input: Parameters<typeof buildLlmTranscript>[0],
  options: Readonly<{ byteLimit?: number }> = {},
  additionalRefs: readonly ContentRef[] = [],
) {
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
  // A status-only line is complete as built; its source body stays closed.
  const bodylessIds = new Set(
    entries.filter((entry) =>
      entry.peerToolStatus && !entry.peerToolStatus.showsOutput
    ).map((entry) => entry.sourceId),
  );
  const ids = [
    ...new Set(
      entries.map((entry) => entry.sourceId).filter((id) =>
        !bodylessIds.has(id)
      ),
    ),
  ];
  const inlineLimit = toolResultLimit(context);
  const budget = byteBudget(options.byteLimit);
  budget.add(
    entries.reduce(
      (total, { peerToolStatus }) =>
        total +
        (peerToolStatus
          ? bodyBytes(peerToolStatusContent(peerToolStatus, []))
          : 0),
      0,
    ),
  );

  // 1. What is stored: the messages, verified against the captured history.
  const records = new Map<string, CollectionRecord>();
  const lists = new Map<string, unknown[][]>();
  const references = new Map<string, ContentRef[]>();
  for (
    const [id, record] of await loadStored(
      messages,
      input.threadId,
      ids,
      snapshots,
    )
  ) {
    records.set(id, record);
    lists.set(id, referenceLists(record, ownAssistantIds.has(id)));
    references.set(id, referencesIn(lists.get(id)!));
  }

  // 2. How large it is: every Asset row once, without opening a Body.
  const sizes = new Map<string, number>();
  const assetIds = uniqueAssetIds(
    [...references.values()].flat().concat(additionalRefs),
  );
  if (assetIds.length) {
    for (const asset of await context.content.getMany(assetIds)) {
      sizes.set(asset.id, asset.byteLength);
    }
  }
  const sizeOf = (ref: ContentRef) => {
    const size = sizes.get(ref.assetId);
    if (size === undefined) {
      throw new Error(`Message content '${ref.assetId}' is unavailable.`);
    }
    return size;
  };

  // 3. What fits: an oversized Tool result becomes a marker, and the rest is
  //    counted against the budget before any Body is opened.
  const markers = new Map<string, ToolResultMarker>();
  for (const id of ids) {
    if (!toolResultIds.has(id)) continue;
    const totalBytes = references.get(id)!.reduce(
      (total, ref) => total + sizeOf(ref),
      0,
    );
    if (totalBytes > inlineLimit) {
      const text = toolResultMarker(id, totalBytes);
      markers.set(id, {
        text,
        bytes: new TextEncoder().encode(text).byteLength,
      });
    }
  }
  const opened = ids.filter((id) => !markers.has(id));
  for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
    const batch = ids.slice(offset, offset + BATCH_SIZE);
    budget.add(
      batch.reduce((total, id) => total + (markers.get(id)?.bytes ?? 0), 0) +
        uniqueAssetIds(
          batch.filter((id) => !markers.has(id)).flatMap((id) =>
            references.get(id)!
          ),
        ).reduce((total, assetId) => total + sizes.get(assetId)!, 0),
    );
  }

  // 4. Open what remains in one resolution; the Asset rows are already held.
  const toOpen = opened.flatMap((id) => references.get(id)!);
  const allRefs = [...toOpen, ...additionalRefs];
  const bodies = allRefs.length
    ? await context.content.resolveMany(allRefs)
    : [];
  const resolved = new Map<ContentRef, ResolvedContent>(
    toOpen.map((ref, index) => [ref, bodies[index]]),
  );
  for (const id of opened) {
    for (const list of lists.get(id)!) {
      for (const [index, ref] of list.entries()) {
        list[index] = resolvedReference(ref as ContentRef, resolved);
      }
    }
  }

  return {
    transcript: entries.map((entry) => ({
      ...entry,
      message: withBodies(
        entry,
        records.get(entry.sourceId),
        markers.get(entry.sourceId),
        ownAssistantIds.has(entry.sourceId),
      ),
    })),
    additional: bodies.slice(toOpen.length),
  };
}

/** A reference with its body attached, or closed when the prompt may not carry it. */
function resolvedReference(
  ref: ContentRef,
  resolved: ReadonlyMap<ContentRef, ResolvedContent>,
) {
  const { value: _body, resolve: _policy, ...descriptor } = ref as
    & ContentRef
    & {
      value?: unknown;
      resolve?: unknown;
    };
  const item = resolved.get(ref);
  if (!item) return { ...descriptor, resolve: false };
  return {
    ...descriptor,
    value: ref.kind === "text"
      ? item.text
      : ref.kind === "json"
      ? item.value
      : item.bytes,
  };
}

/** Ordinary typed history preparation, with no extra context inputs. */
export async function prepareLlmTranscript(
  context: CoreProcessorContext,
  input: Parameters<typeof buildLlmTranscript>[0],
  options: Readonly<{ byteLimit?: number }> = {},
): Promise<readonly LlmTranscriptEntry[]> {
  return (await prepareTranscript(context, input, options)).transcript;
}

/** Resolve history and application context in the same metadata/body batches. */
export async function prepareLlmInput(
  context: CoreProcessorContext,
  input: Parameters<typeof buildLlmTranscript>[0],
  contextInputs: readonly ContentInput[],
  options: Readonly<{ byteLimit?: number }> = {},
): Promise<
  Readonly<{
    transcript: readonly LlmTranscriptEntry[];
    contextValues: readonly ContentValue[];
  }>
> {
  const snapshot = structuredClone(contextInputs);
  const refs = snapshot.filter(isContentRef);
  const prepared = await prepareTranscript(context, input, options, refs);
  const contextValues = await resolveContentInputs(snapshot, {
    resolveMany: () => Promise.resolve(prepared.additional),
  });
  return { transcript: prepared.transcript, contextValues };
}
