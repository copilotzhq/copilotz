import { inspectMemoryAction } from "../../../actions/inspect-memory/index.ts";
/** Tool resource exposing one semantic-memory record inspection. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";

export const inspectMemoryTool: ToolResource<"inspect_memory"> = defineTool(
  "inspect_memory",
  inspectMemoryAction,
  {
    name: "Inspect Memory",
    description:
      "Inspect one accessible semantic memory, its provenance, time, and graph relations.",
  },
);

export default inspectMemoryTool;
