import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import { settleCheckpointError } from "../../shared/checkpoints.ts";
import { record } from "../../shared/input.ts";
import { recoverMemoryCheckpointProducer } from "../../shared/dispatch.ts";
import { REQUEST_MEMORY_CHECKPOINT_RECOVERY_ACTION_ID } from "../../actions/request-checkpoint-recovery/index.ts";

/** Repairs a demonstrably missing producer outside every waiting user scope. @module */
export const recoverMemoryConsolidationProcessor: Processor<
  MemoryProcessorContext
> = defineProcessor({
  id: "copilotz.memory.recover-consolidation",
  on: [{
    eventType: `${REQUEST_MEMORY_CHECKPOINT_RECOVERY_ACTION_ID}.completed`,
  }],
  settlement: "detached",
  async handle(event, context) {
    if (!event.durable) return;
    const receipt = parseActionLifecycleEvent(event, {
      actionId: REQUEST_MEMORY_CHECKPOINT_RECOVERY_ACTION_ID,
      statuses: ["completed"],
    });
    if (receipt?.status !== "completed") return;
    const checkpointId = record(receipt.input).checkpointId;
    if (typeof checkpointId !== "string" || !checkpointId.trim()) return;
    const checkpoint = await context.collections.longTermMemory.get({
      id: checkpointId,
    });
    if (!checkpoint || checkpoint.status !== "pending") return;
    await recoverMemoryCheckpointProducer(context, checkpoint.id);
  },
  async onError(error, event, context) {
    if (!event.durable) return false;
    const receipt = parseActionLifecycleEvent(event, {
      actionId: REQUEST_MEMORY_CHECKPOINT_RECOVERY_ACTION_ID,
      statuses: ["completed"],
    });
    const checkpointId = receipt?.status === "completed"
      ? record(receipt.input).checkpointId
      : undefined;
    if (typeof checkpointId !== "string" || !checkpointId.trim()) return false;
    await settleCheckpointError(
      context,
      checkpointId,
      context.signal.aborted ? "cancelled" : "failed",
      error,
    );
    return true;
  },
});

export default recoverMemoryConsolidationProcessor;
