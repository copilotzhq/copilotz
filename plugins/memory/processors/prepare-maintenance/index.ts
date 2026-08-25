/** Starts memory maintenance after a checkpoint is reserved. @module */
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import {
  type MemoryProcessorContext,
  prepareMemoryMaintenanceProcessor as createImplementation,
} from "../../internal/implementation.ts";
export function createPrepareMemoryMaintenanceProcessor(): Processor<
  MemoryProcessorContext
> {
  const implementation = createImplementation();
  return defineProcessor({
    id: "copilotz.memory.prepare-attempt",
    on: implementation.on,
    handle: implementation.handle,
  });
}
