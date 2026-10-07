import { inspectMemoryAction } from "../../../actions/inspect-memory/index.ts";
/** Tool resource exposing one semantic-memory record inspection. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";

export const inspectMemoryTool: ToolResource<"inspect_memory"> = defineTool(
  "inspect_memory",
  inspectMemoryAction,
  {
    name: "Inspect Memory",
    description:
      "Inspect accessible notes by their IDs, including full text, checkpoint lineage and retirement details.",
  },
);

export default inspectMemoryTool;
