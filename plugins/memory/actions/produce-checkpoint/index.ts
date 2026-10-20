import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "../../shared/contracts.ts";
import { dispatchMemoryCheckpoint } from "../../shared/dispatch.ts";
import { settleCheckpointError } from "../../shared/checkpoints.ts";

/** The operation stays open through the turn and checkpoint projection. */
export const produceCheckpointAction: ActionDefinition<
  { checkpointId: string },
  { checkpointId: string },
  MemoryActionContext
> = defineAction({
  id: "copilotz.memory.produce-checkpoint",
  inputSchema: {
    type: "object",
    required: ["checkpointId"],
    properties: { checkpointId: { type: "string" } },
    additionalProperties: false,
  } as const,
  async execute(input: { checkpointId: string }, context: MemoryActionContext) {
    const producer = context as unknown as MemoryProcessorContext;
    const checkpoint = await context.collections.longTermMemory.get({
      id: input.checkpointId,
    });
    if (!checkpoint) throw new Error("Memory checkpoint is unavailable.");
    if (checkpoint.status === "pending") {
      try {
        await dispatchMemoryCheckpoint(producer, checkpoint);
      } catch (error) {
        await settleCheckpointError(producer, checkpoint.id, "failed", error);
        throw error;
      }
    }
    return { checkpointId: checkpoint.id };
  },
});

export default produceCheckpointAction;
