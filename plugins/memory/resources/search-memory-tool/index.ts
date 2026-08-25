/** Tool resource exposing searchable semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import type { createSearchMemoryAction } from "../../actions/search-memory/index.ts";
export function createSearchMemoryTool(
  action: ReturnType<typeof createSearchMemoryAction>,
): ToolResource<"search_memory"> {
  return defineTool("search_memory", action, {
    name: "Search Memory",
    description:
      "Search accessible semantic memory by meaning, form, kind, and lifecycle status.",
  });
}
