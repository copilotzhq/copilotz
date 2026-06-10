import type { Queue } from "@/database/schemas/index.ts";
import type { ProcessorDeps } from "@/types/index.ts";

type QueueOps = Pick<
  ProcessorDeps["db"]["ops"],
  "getQueueItemById" | "hasNewerHumanInput"
>;

export interface SupersededEventInfo {
  supersededByNewerHumanInput: true;
  supersededSourceEventId: string;
  supersededSourceEventType: string;
  supersededSourceCreatedAt: string;
}

function eventId(event: Queue): string | null {
  return typeof event.id === "string" ? event.id : null;
}

function eventCreatedAt(event: Queue): string | null {
  const createdAt = event.createdAt;
  if (createdAt instanceof Date) {
    return createdAt.toISOString();
  }
  return typeof createdAt === "string" ? createdAt : null;
}

function eventParentId(event: Queue): string | null {
  return typeof event.parentEventId === "string" ? event.parentEventId : null;
}

async function resolveContinuationSource(
  ops: QueueOps,
  parentEventId: string,
): Promise<Queue | null> {
  const parent = await ops.getQueueItemById(parentEventId);
  if (!parent) {
    return null;
  }

  if (parent.eventType !== "LLM_RESULT" && parent.eventType !== "TOOL_RESULT") {
    return parent;
  }

  const grandparentId = eventParentId(parent);
  if (!grandparentId) {
    return parent;
  }

  return await ops.getQueueItemById(grandparentId) ?? parent;
}

export async function detectNewerHumanInputSupersession(
  ops: QueueOps,
  threadId: string,
  parentEventId: string | null | undefined,
  namespace?: string,
): Promise<SupersededEventInfo | null> {
  if (!parentEventId) {
    return null;
  }

  const source = await resolveContinuationSource(ops, parentEventId);
  if (!source) {
    return null;
  }

  const sourceCreatedAt = eventCreatedAt(source);
  const sourceEventId = eventId(source);
  if (!sourceCreatedAt || !sourceEventId) {
    return null;
  }

  const superseded = await ops.hasNewerHumanInput(
    threadId,
    sourceCreatedAt,
    namespace,
  );

  if (!superseded) {
    return null;
  }

  return {
    supersededByNewerHumanInput: true,
    supersededSourceEventId: sourceEventId,
    supersededSourceEventType: String(source.eventType),
    supersededSourceCreatedAt: sourceCreatedAt,
  };
}

export function withSupersededSkipRoutingMetadata(
  metadata: unknown,
  superseded: SupersededEventInfo,
): Record<string, unknown> {
  const base = metadata && typeof metadata === "object" &&
      !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};

  return {
    ...base,
    skipRouting: true,
    ...superseded,
  };
}
