import { searchMemoryAction } from "../../../actions/search-memory/index.ts";
/** Tool resource exposing searchable semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";

export const searchMemoryTool: ToolResource<"search_memory"> = defineTool(
  "search_memory",
  searchMemoryAction,
  {
    name: "Search Memory",
    description:
      "Search accessible semantic memory by meaning, form, kind, and lifecycle status.",
  },
);

export default searchMemoryTool;
