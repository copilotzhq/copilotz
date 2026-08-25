/** Lists memory spaces available to the current action provenance. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  listSpacesAction as createImplementation,
  type MemoryActionContext,
} from "../../internal/implementation.ts";
export function createListKnowledgeSpacesAction(): ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema
> {
  const implementation = createImplementation();
  return defineAction({
    id: "copilotz.memory.spaces.list",
    inputSchema: implementation.inputSchema,
    execute: implementation.execute,
  });
}
