/** Settles failed or omitted scoped memory-consolidation Agent turns. @module */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  type MemoryProcessorContext,
  settleMemoryConsolidationProcessor as createImplementation,
} from "../../internal/implementation.ts";

/** Owns Memory-specific recovery around the otherwise ordinary Core turn. */
export function createSettleMemoryConsolidationProcessor(): Processor<
  MemoryProcessorContext
> {
  const implementation = createImplementation();
  return defineProcessor({
    id: "copilotz.memory.settle-consolidation",
    on: implementation.on,
    settlement: implementation.settlement,
    handle: implementation.handle,
  });
}
