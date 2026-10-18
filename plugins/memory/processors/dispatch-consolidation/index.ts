import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Dispatches a scoped Core Agent turn for a reserved checkpoint. @module */
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import {
  memoryCheckpointOperation,
  settleCheckpointError,
} from "../../shared/checkpoints.ts";
import { record } from "../../shared/input.ts";

export const dispatchMemoryConsolidationProcessor: Processor<
  MemoryProcessorContext
> = defineProcessor({
  id: "copilotz.memory.dispatch-consolidation",
  on: [{ eventType: "long_term_memory.created" }],
  settlement: "detached",
  async handle(event, context) {
    if (!memoryConfig(context).enabled || !event.durable || !event.subject) {
      return;
    }
    const checkpoint = await context.collections.longTermMemory.get({
      id: event.subject.id,
    });
    if (!checkpoint || checkpoint.status !== "pending") return;
    if (record(checkpoint.metadata).onDemand === true) return;
    await memoryCheckpointOperation(context, checkpoint.id);
  },
  async onError(error, event, context) {
    if (!event.durable || !event.subject?.id) return false;
    await settleCheckpointError(context, event.subject.id, "failed", error);
    return true;
  },
});

export default dispatchMemoryConsolidationProcessor;
