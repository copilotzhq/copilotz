import { ulid } from "ulid";
import type { Event, EventProcessor, ProcessorDeps } from "@/types/index.ts";
import { EVENT_PRIORITIES } from "@/runtime/event-priority.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";
import { createMessageService } from "@/runtime/collections/native.ts";
import {
  getLatestReadyLongTermMemory,
  getLongTermMemoryConfig,
  getNextLongTermMemorySequence,
  getPendingLongTermMemory,
  resolveThreadMemorySpaces,
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

export const processorId = "memory_reservation";
export const eventTypes = ["message.created"] as const;
export const priority = 10;

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
          "[memory_reservation] Long-term memory requires embedding configuration.",
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
      const messageService = createMessageService({
        collections: deps.context.collections,
        ops: deps.db.ops,
      });
      const history = await messageService.getHistory(threadId, agentId);
      const range = await selectLongTermMemoryRange({
        messages: history,
        triggerMessageId,
        previous,
        triggerEstimatedTokens: config.triggerEstimatedTokens,
        retainRecentEstimatedTokens: config.retainRecentEstimatedTokens,
      });
      if (!range) return;

      let memorySpaces = await resolveThreadMemorySpaces(
        deps.db,
        threadId,
        namespace,
      );
      if (!memorySpaces.some((space) => space.access === "read_write")) {
        const memorySpaceId = ulid();
        await deps.db.ops.mutate.graph.mutateMany({
          createNodes: [{
            id: memorySpaceId,
            namespace,
            type: "memory_space",
            name: `thread:${threadId}`,
            content: null,
            data: {
              scopeType: "thread",
              scopeId: threadId,
            },
            sourceType: "thread",
            sourceId: threadId,
          }],
          createEdges: [{
            sourceNodeId: threadId,
            targetNodeId: memorySpaceId,
            type: GRAPH_EDGE.USES_MEMORY_SPACE,
            data: {
              access: "read_write",
              defaultWrite: true,
            },
          }],
        }, {
          threadId,
          namespace,
          traceId: typeof event.traceId === "string" ? event.traceId : null,
          causationId: typeof event.id === "string" ? event.id : null,
        });
        memorySpaces = await resolveThreadMemorySpaces(
          deps.db,
          threadId,
          namespace,
        );
        if (!memorySpaces.some((space) => space.defaultWrite)) {
          throw new Error("Failed to create thread memory space.");
        }
      }
      const readMemorySpaceIds = memorySpaces.map((space) =>
        String(space.node.id)
      );
      const writeMemorySpaceIds = memorySpaces
        .filter((space) => space.access === "read_write")
        .map((space) => String(space.node.id));
      const defaultWriteSpace = memorySpaces.find((space) =>
        space.defaultWrite
      );
      if (!defaultWriteSpace) {
        throw new Error("Thread has no default writable memory space.");
      }
      const defaultWriteMemorySpaceId = String(defaultWriteSpace.node.id);

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
          schemaVersion: "2",
          strategy: "checkpointed_graph",
          status: "pending",
          threadId,
          readMemorySpaceIds,
          writeMemorySpaceIds,
          defaultWriteMemorySpaceId,
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
        "[memory_reservation] Failed to reserve checkpoint:",
        error,
      );
    }
  },
};

export const { shouldProcess, process } = longTermMemoryTriggerProcessor;
