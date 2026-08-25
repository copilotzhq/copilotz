/** Reserves eligible conversation history for memory maintenance. @module */
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  type MemoryProcessorContext,
  memoryReservationProcessor as createImplementation,
} from "../../internal/implementation.ts";
import type { LongTermMemoryConfig } from "../../resources/config/index.ts";
export function createMemoryReservationProcessor(
  config: LongTermMemoryConfig,
): Processor<MemoryProcessorContext> {
  const implementation = createImplementation(config);
  return defineProcessor({
    id: "copilotz.memory.reserve",
    on: implementation.on,
    settlement: implementation.settlement,
    handle: implementation.handle,
  });
}
