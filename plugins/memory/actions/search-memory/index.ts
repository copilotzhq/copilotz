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
    id: "copilotz.memory.search",
    inputSchema: implementation.inputSchema,
    outputSchema: implementation.outputSchema,
    execute: implementation.execute,
  });
}
