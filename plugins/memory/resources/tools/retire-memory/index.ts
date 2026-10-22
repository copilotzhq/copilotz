/** Memory tool. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";
import { retireMemoryAction } from "../../../actions/retire-memory/index.ts";
const tool: ToolResource<"retire_memory"> = defineTool(
  "retire_memory",
  retireMemoryAction,
  {
    history: { visibility: "requester_only" },
    name: "Retire Memory",
    description:
      "Permanently retire a visible memory item. To correct an item, use remember with replaces.",
  },
);
export default tool;
