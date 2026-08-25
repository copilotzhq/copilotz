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
  ActionSchema
> {
  const implementation = createImplementation();
  return defineAction({
    id: "copilotz.memory.inspect",
    inputSchema: implementation.inputSchema,
    execute: implementation.execute,
  });
}
