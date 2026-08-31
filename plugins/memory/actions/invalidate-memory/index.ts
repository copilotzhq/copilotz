/** Invalidates one accessible semantic-memory record without changing its lifecycle. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  invalidateMemoryAction as createImplementation,
  type MemoryActionContext,
} from "../../internal/implementation.ts";

export function createInvalidateMemoryAction(): ActionDefinition<
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
    id: "copilotz.memory.invalidate",
    inputSchema: implementation.inputSchema,
    outputSchema: implementation.outputSchema,
    execute: implementation.execute,
  });
}
