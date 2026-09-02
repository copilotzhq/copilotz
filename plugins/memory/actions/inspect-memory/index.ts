/** Inspects one accessible semantic-memory record. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  inspectMemoryAction as createImplementation,
  type MemoryActionContext,
} from "../../internal/implementation.ts";
export function createInspectMemoryAction(): ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema,
  ReturnType<typeof createImplementation>["outputSchema"]
> {
  const implementation = createImplementation();
  return defineAction<
    unknown,
    unknown,
    MemoryActionContext,
    ActionSchema,
    ReturnType<typeof createImplementation>["outputSchema"]
  >({
    id: "copilotz.memory.inspect",
    inputSchema: implementation.inputSchema,
    outputSchema: implementation.outputSchema,
    execute: implementation.execute,
  });
}
