import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { LlmMessage } from "@copilotz/copilotz/llm";
import type { ConversationMessage } from "../contracts.ts";
import type { CoreProcessorContext } from "../runtime-context.ts";
import { buildLlmTranscript } from "./transcript.ts";
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
  // Only the speaking Agent may receive its opaque provider state or readable
  // reasoning. Peer assistant turns remain ordinary user-visible history.
  const ownAssistantSources = new Set(
    sources.filter((id, index) =>
      transcript[index].role === "assistant" &&
      snapshots.get(id)?.sender.id === input.participantId
    ),
  );
  const resolved = new Map<string, CollectionRecord>();
  const messages = context.collections.message;
  if (!messages) throw new Error("Core requires the Message Collection.");
  let usedBytes = 0;
  for (const reasoning of [false, true]) {
    const ids = [...new Set(sources)].filter((id) =>
      ownAssistantSources.has(id) === reasoning
    );
    for (let offset = 0; offset < ids.length; offset += 20) {
      let records: readonly CollectionRecord[];
      try {
        records = await messages.list({
          where: { threadId: input.threadId },
          // Match the captured record before resolved-read can open any Body.
          filter: {
            or: ids.slice(offset, offset + 20).flatMap((id) => {
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
      if (options.byteLimit !== undefined && usedBytes > options.byteLimit) {
        throw createContentByteLimitError(usedBytes, options.byteLimit);
      }
      for (const record of records) resolved.set(record.id, record);
    }
  }
  return (transcript.map((message, index) => {
    const record = resolved.get(sources[index]);
    if (!record) throw new Error("Message history is no longer available.");
    const common = {
      ...message,
      content: record.content as LlmMessage["content"],
    };
    if (common.role !== "assistant") return common;
    const metadata = record.metadata as ConversationMessage["metadata"];
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
