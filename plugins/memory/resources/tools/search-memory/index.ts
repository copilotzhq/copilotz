import { searchMemoryAction } from "../../../actions/search-memory/index.ts";
/** Tool resource exposing searchable semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";

export const searchMemoryTool: ToolResource<"search_memory"> = defineTool(
  "search_memory",
  searchMemoryAction,
  {
    history: { visibility: "requester_only" },
    name: "Search Memory",
    description:
      "Search the initiating human's personal memory, this thread's current Core space memory, and this thread's continuity notes. Active notes are returned by default; includeRetired also searches their audit history.",
  },
);

export default searchMemoryTool;
