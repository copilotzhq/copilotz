/** Searches accessible semantic-memory records. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type MemoryActionContext,
  searchMemoryAction as createImplementation,
} from "../../internal/implementation.ts";
export function createSearchMemoryAction(): ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema
> {
  const implementation = createImplementation();
  return defineAction({
    id: "copilotz.memory.search",
    inputSchema: implementation.inputSchema,
    execute: implementation.execute,
  });
}
