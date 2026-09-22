import { coreEvent } from "../../../core/shared/events/index.ts";
import { memoryConfig } from "../../resources/memory/config/index.ts";
/** Reserves eligible durable conversation history for consolidation. @module */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import { reserveMemoryCheckpoint } from "../../shared/reservation.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function eventMessageRecord(value: unknown): CollectionRecord | null {
  const message = record(record(value).record);
  return typeof message.id === "string" && message.id.trim()
    ? message as CollectionRecord
    : null;
}

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
      if (!event.durable || !coreEvent(event).threadId) {
        return;
      }
      const messageRecord = eventMessageRecord(event.data);
      if (!messageRecord) {
        return;
      }
      await reserveMemoryCheckpoint(context, messageRecord, config);
    },
  });
export default memoryReservationProcessor;
