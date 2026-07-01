import { ulid } from "ulid";
import type { Event, EventProcessor, ProcessorDeps } from "@/types/index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import {
  findMemorySpace,
  getLatestReadyLongTermMemory,
  getLongTermMemoryConfig,
  getNextLongTermMemorySequence,
  getPendingLongTermMemory,
  selectLongTermMemoryRange,
} from "@/runtime/memory/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAgentId(event: Event): string | null {
  const payload: Record<string, unknown> = isRecord(event.payload)
    ? event.payload
    : {};
  const sender = isRecord(payload.sender) ? payload.sender : {};
  const senderType = sender.type ?? payload.senderType;
  if (senderType !== "agent") return null;
  const id = typeof sender.id === "string" ? sender.id.trim() : "";
  const name = typeof sender.name === "string" ? sender.name.trim() : "";
  const senderId = typeof payload.senderId === "string"
    ? payload.senderId.trim()
    : "";
  return id || name || senderId || null;
}

async function getTriggerMessageId(
  event: Event,
  deps: ProcessorDeps,
): Promise<string | null> {
  const subjectId = typeof event.subjectId === "string"
    ? event.subjectId
    : null;
  if (!subjectId) return null;
  const node = await deps.db.ops.unsafeGraph.getNodeById(subjectId);
  const data = node && isRecord(node.data) ? node.data : {};
  return typeof data.messageId === "string" ? data.messageId : subjectId;
}

export const priority = 10;
export const eventType = "message.created";

export const longTermMemoryTriggerProcessor: EventProcessor<
  unknown,
  ProcessorDeps
> = {
  shouldProcess: (event, deps) =>
    (event as unknown as { type: string }).type === "message.created" &&
    getAgentId(event) !== null &&
    getLongTermMemoryConfig(deps.context.memory) !== null,

  process: async (event, deps) => {
    try {
      const config = getLongTermMemoryConfig(deps.context.memory);
      const agentId = getAgentId(event);
      const threadId = typeof event.threadId === "string"
        ? event.threadId
        : null;
      const namespace = deps.context.namespace ??
        (typeof deps.thread.namespace === "string"
          ? deps.thread.namespace
          : null);
      if (!config || !agentId || !threadId || !namespace) return;
      if (!deps.context.embeddingConfig) {
        console.warn(
          "[long_term_memory_trigger] Long-term memory requires embedding configuration.",
        );
        return;
      }

      const pending = await getPendingLongTermMemory(
        deps.db,
        threadId,
        namespace,
        agentId,
      );
      if (pending) return;

      const triggerMessageId = await getTriggerMessageId(event, deps);
      if (!triggerMessageId) return;
      const previous = await getLatestReadyLongTermMemory(
        deps.db,
        threadId,
        namespace,
        agentId,
      );
      const range = await selectLongTermMemoryRange({
        db: deps.db,
        threadId,
        triggerMessageId,
        previous,
        triggerEstimatedTokens: config.triggerEstimatedTokens,
        retainRecentEstimatedTokens: config.retainRecentEstimatedTokens,
        maxToolResultEstimatedTokens:
          deps.context.toolResultHistoryMaxEstimatedTokens,
      });
      if (!range) return;

      let memorySpace = await findMemorySpace(
        deps.db,
        threadId,
        namespace,
      );
      if (!memorySpace) {
        const memorySpaceId = ulid();
        const result = await deps.db.ops.mutate.graph.mutateMany({
          createNodes: [{
            id: memorySpaceId,
            namespace,
            type: "memory_space",
            name: `thread:${threadId}`,
            content: null,
            data: {
              kind: "thread",
              ownerNodeId: threadId,
              threadId,
            },
            sourceType: "thread",
            sourceId: threadId,
          }],
          createEdges: [{
            sourceNodeId: threadId,
            targetNodeId: memorySpaceId,
            type: GRAPH_EDGE.OWNS_MEMORY_SPACE,
          }],
        }, {
          threadId,
          namespace,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
        });
        memorySpace = result.createdNodes[0] ?? null;
        if (!memorySpace) {
          throw new Error("Failed to create thread memory space.");
        }
      }

      const sequence = await getNextLongTermMemorySequence(
        deps.db,
        threadId,
        namespace,
        agentId,
      );
      const backgroundExternalId = `${threadId}:long-term-memory:${agentId}`;
      const existingBackgroundThread = await deps.db.ops.getThreadByExternalId(
        backgroundExternalId,
        namespace,
      );
      const backgroundThread = existingBackgroundThread ??
        await deps.db.ops.findOrCreateThread(undefined, {
          name: "Long-term Memory",
          description: `Long-term-memory worker for ${threadId}`,
          participants: [],
          externalId: backgroundExternalId,
          namespace,
          parentThreadId: threadId,
          status: "active",
          mode: "immediate",
        });
      const backgroundThreadId = String(backgroundThread.id);
      await deps.db.ops.mutate.graph.createNode({
        namespace,
        type: "long_term_memory",
        name: `thread:${threadId}:agent:${agentId}:memory:${sequence}`,
        content: null,
        embedding: null,
        data: {
          schemaVersion: "1",
          strategy: "checkpointed_graph",
          status: "pending",
          threadId,
          memorySpaceId: String(memorySpace.id),
          sequence,
          agentId,
          sourceStartMessageId: range.sourceStartMessageId,
          sourceEndMessageId: range.sourceEndMessageId,
          metadata: {
            estimatedTokens: range.estimatedTokens,
            retainedEstimatedTokens: range.retainedEstimatedTokens,
            retainedMessageCount: range.retainedMessageCount,
          },
        },
        sourceType: "thread",
        sourceId: threadId,
      }, {
        threadId: backgroundThreadId,
        namespace,
        traceId: typeof event.traceId === "string" ? event.traceId : null,
        causationId: typeof event.id === "string" ? event.id : null,
        priority: EVENT_PRIORITIES.NORMAL,
        status: "pending",
      });
      return { backgroundThreadIds: [backgroundThreadId] };
    } catch (error) {
      console.warn(
        "[long_term_memory_trigger] Failed to reserve checkpoint:",
        error,
      );
    }
  },
};

export const { shouldProcess, process } = longTermMemoryTriggerProcessor;
