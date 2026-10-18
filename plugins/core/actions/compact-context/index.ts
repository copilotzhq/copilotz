/** Durable foreground maintenance; private maintenance content stays separate. @module */
import {
  type ActionContinuation,
  type ActionDefinition,
  defineAction,
  type OperationOutcome,
} from "@copilotz/copilotz/actions";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { CoreActionContext } from "../../shared/runtime-context.ts";
import { coreAgent } from "../../shared/runtime-context.ts";
import {
  loadCoreThreadMetadata,
  participantAgentId,
} from "../../shared/helpers.ts";
import { mapParticipantRecord } from "../../shared/projections.ts";
import { isContextResource } from "../../authoring/define-context/index.ts";
import type {
  CompactContextInput,
  ContextResource,
} from "../../shared/types.ts";

export const COMPACT_CONTEXT_ACTION_ID = "copilotz.core.context.compact";

const inputSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "threadId",
    "agentId",
    "participantId",
    "triggerMessageId",
    "estimatedTokens",
    "limitEstimatedTokens",
    "historyLimitEstimatedTokens",
  ],
  properties: {
    threadId: { type: "string", minLength: 1 },
    agentId: { type: "string", minLength: 1 },
    participantId: { type: "string", minLength: 1 },
    triggerMessageId: { type: "string", minLength: 1 },
    triggerEventId: { type: "string", minLength: 1 },
    routeCorrelationId: { type: "string", minLength: 1 },
    historyAfterMessageId: { type: "string", minLength: 1 },
    estimatedTokens: { type: "number", minimum: 1 },
    limitEstimatedTokens: { type: "number", minimum: 1 },
    historyLimitEstimatedTokens: { type: "number", minimum: 0 },
  },
} as const;

type Input = {
  threadId: string;
  agentId: string;
  participantId: string;
  triggerMessageId: string;
  triggerEventId?: string;
  routeCorrelationId?: string;
  historyAfterMessageId?: string;
  estimatedTokens: number;
  limitEstimatedTokens: number;
  historyLimitEstimatedTokens: number;
};
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["advanced"],
  properties: {
    advanced: { type: "boolean" },
    resume: { type: "boolean" },
  },
} as const;

type Output = { advanced: boolean; resume?: boolean };
type ReadableCheckpointState =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "ready"; advances: boolean }>;
type CompactWait = Readonly<{
  schema: "copilotz.core.context-compaction-wait.v1";
  resourceId: string;
  checkpointId: string;
  input: Input;
}>;

function waitWork(value: unknown): CompactWait {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Compaction wait work is invalid.");
  }
  const work = value as Record<string, unknown>;
  if (
    work.schema !== "copilotz.core.context-compaction-wait.v1" ||
    typeof work.resourceId !== "string" ||
    typeof work.checkpointId !== "string" || !work.input
  ) throw new TypeError("Compaction wait work is invalid.");
  return work as CompactWait;
}

async function authorized(input: Input, context: CoreActionContext) {
  const metadata = await loadCoreThreadMetadata(context, input.threadId);
  const participant = metadata.participantRecords.find((entry) =>
    entry.id === input.participantId
  );
  const agent = coreAgent(context.resources, input.agentId);
  if (
    !agent || participant?.participantType !== "agent" ||
    participantAgentId(participant) !== agent.id
  ) {
    throw new Error("The Agent is no longer authorized in this conversation.");
  }
  return { metadata, participant, agent } as const;
}

function compactInput(
  input: Input,
  context: CoreActionContext,
  metadata: Awaited<ReturnType<typeof loadCoreThreadMetadata>>,
  participant: NonNullable<
    Awaited<
      ReturnType<typeof loadCoreThreadMetadata>
    >["participantRecords"][number]
  >,
  agent: NonNullable<ReturnType<typeof coreAgent>>,
): CompactContextInput {
  return {
    ...input,
    purpose: "conversation",
    agent,
    participant: mapParticipantRecord(participant),
    thread: metadata.thread,
    collections: context.collections,
    context: context as unknown as ProcessorContext,
    signal: context.signal,
    idempotencyKey: context.operationKey,
  };
}

async function checkedState(
  resource: ContextResource,
  input: CompactContextInput,
  checkpointId: string,
): Promise<ReadableCheckpointState> {
  if (!resource.checkCompact) {
    throw new Error(
      `Context resource '${resource.id}' cannot check operation-backed compaction.`,
    );
  }
  const state = await resource.checkCompact(input, checkpointId);
  if (state.status === "failed" || state.status === "cancelled") {
    throw new Error(
      `Context checkpoint '${checkpointId}' ${state.status}` +
        (state.message ? `: ${state.message}` : "."),
    );
  }
  if (state.status === "missing") {
    throw new Error(`Context checkpoint '${checkpointId}' disappeared.`);
  }
  if (state.status !== "pending" && state.status !== "ready") {
    throw new Error(
      `Context checkpoint '${checkpointId}' has an invalid state.`,
    );
  }
  return state;
}

export const compactContextAction: ActionDefinition<
  Input,
  Output | ActionContinuation,
  CoreActionContext,
  typeof inputSchema,
  typeof outputSchema
> = defineAction({
  id: COMPACT_CONTEXT_ACTION_ID,
  inputSchema,
  outputSchema,
  async execute(input, context) {
    const { metadata, participant, agent } = await authorized(input, context);
    const prepared = compactInput(input, context, metadata, participant, agent);
    for (
      const resource of Object.values(context.resources.promptContext ?? {})
    ) {
      if (
        !isContextResource(resource) ||
        (!resource.compact && !resource.reserveCompact)
      ) continue;
      context.signal.throwIfAborted();
      if (resource.reserveCompact && resource.checkCompact) {
        const seen = new Set<string>();
        for (;;) {
          const reservation = await resource.reserveCompact(prepared);
          if (reservation.status === "none") break;
          if (reservation.status === "ready") return { advanced: true };
          if (seen.has(reservation.checkpointId)) {
            throw new Error(
              "Memory reservation did not advance the conversation history boundary.",
            );
          }
          seen.add(reservation.checkpointId);
          const state = await checkedState(
            resource,
            prepared,
            reservation.checkpointId,
          );
          if (state.status === "pending") {
            return context.awaitOperation({
              start: reservation.start,
              handoff: {
                schema: "copilotz.core.context-compaction-wait.v1",
                resourceId: resource.id,
                checkpointId: reservation.checkpointId,
                input,
              } satisfies CompactWait,
            });
          }
          if (state.advances) return { advanced: true };
          // A concurrent route may have consumed this range while the
          // checkpoint was pending. Reserve the next tail without polling.
        }
        continue;
      }
      if (resource.compact && await resource.compact(prepared)) {
        return { advanced: true };
      }
    }
    throw new Error(
      "Conversation history cannot be consolidated into a safe bounded range.",
    );
  },
  async resume(handoff: unknown, outcome: OperationOutcome, context) {
    const wait = waitWork(handoff);
    const input = wait.input;
    if (outcome.status !== "completed") {
      throw new Error(`Context compaction ${outcome.status}.`);
    }
    const { metadata, participant, agent } = await authorized(input, context);
    const resource = Object.values(context.resources.promptContext ?? {}).find(
      (candidate) =>
        isContextResource(candidate) && candidate.id === wait.resourceId,
    );
    if (!resource || !isContextResource(resource) || !resource.checkCompact) {
      throw new Error(`Context resource '${wait.resourceId}' is unavailable.`);
    }
    const prepared = compactInput(input, context, metadata, participant, agent);
    const state = await checkedState(resource, prepared, wait.checkpointId);
    if (state.status === "pending") {
      throw new Error(
        "Compaction producer settled without completing its checkpoint.",
      );
    }
    // A completed receipt is consumed by Core's router processor. Re-entering
    // from a processor context keeps the LLM Action at the root of its scope,
    // where the normal result projector can observe it.
    return { advanced: true, resume: true };
  },
});

export default compactContextAction;
