/** Changes an accessible semantic-memory record lifecycle status. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type MemoryActionContext,
  setMemoryStatusAction as createImplementation,
} from "../../internal/implementation.ts";
export function createSetMemoryStatusAction(): ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema
> {
  const implementation = createImplementation();
  return defineAction({
    id: "copilotz.memory.status.set",
    inputSchema: implementation.inputSchema,
    execute: implementation.execute,
  });
}
