/** Dispatches one detached, scoped Core Agent turn for a reserved checkpoint. @module */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  dispatchMemoryConsolidationProcessor as createImplementation,
  type MemoryProcessorContext,
} from "../../internal/implementation.ts";

/** Starts normal-Agent consolidation after a checkpoint reservation commits. */
export function createDispatchMemoryConsolidationProcessor(): Processor<
  MemoryProcessorContext
> {
  const implementation = createImplementation();
  return defineProcessor({
    id: "copilotz.memory.dispatch-consolidation",
    on: implementation.on,
    settlement: implementation.settlement,
    handle: implementation.handle,
  });
}
