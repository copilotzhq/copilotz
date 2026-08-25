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
      "Persist one internal, provenance-aware semantic memory consolidation. This tool is granted only during Copilotz memory maintenance.",
    history: { visibility: "requester_only" },
  });
}
export { CONSOLIDATE_MEMORY_ACTION_ID };
