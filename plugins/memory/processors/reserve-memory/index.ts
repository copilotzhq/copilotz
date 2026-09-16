import { coreEvent } from "../../../core/shared/events/index.ts";
import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Reserves eligible durable conversation history for consolidation. @module */
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import { reserveMemoryCheckpoint } from "../../shared/reservation.ts";
export const memoryReservationProcessor: Processor<MemoryProcessorContext> =
  defineProcessor({
    id: "copilotz.memory.reserve",
    on: [{ eventType: "message.created" }],
    settlement: "detached",
    async handle(event, context) {
      const config = memoryConfig(context);
      if (!config.enabled) {
        return;
      }
      if (coreEvent(event).visibility?.kind === "internal") {
        return;
      }
      if (!event.durable || !coreEvent(event).threadId || !event.subject) {
        return;
      }
      const messageRecord = await context.collections.message.get({
        id: event.subject.id,
      });
      if (!messageRecord) {
        return;
      }
      await reserveMemoryCheckpoint(context, messageRecord, config);
    },
  });
export default memoryReservationProcessor;
