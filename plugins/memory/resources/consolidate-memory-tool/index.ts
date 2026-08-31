/** Tool resource exposing semantic-memory consolidation to an LLM. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import { CONSOLIDATE_MEMORY_ACTION_ID } from "../../actions/consolidate-memory/index.ts";
export function createConsolidateMemoryTool(
  action: ReturnType<
    typeof import("../../actions/consolidate-memory/index.ts").createConsolidateMemoryAction
  >,
): ToolResource<"consolidate_memory"> {
  return defineTool("consolidate_memory", action, {
    name: "Consolidate Memory",
    description:
      "Persist a provenance-aware semantic memory consolidation from the current trusted Agent turn. The input schema documents every registered kind and its semantics. Use localId for references inside one payload, canonical memoryId values from memory context/search/inspection for existing memories, omit spaceId to use the trusted default, and never invent evidence IDs. Use outcome=no_changes when nothing durable changed.",
    history: { visibility: "requester_only" },
  });
}
export { CONSOLIDATE_MEMORY_ACTION_ID };
