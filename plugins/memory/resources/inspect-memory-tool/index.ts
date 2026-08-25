/** Tool resource exposing one semantic-memory record inspection. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import type { createInspectMemoryAction } from "../../actions/inspect-memory/index.ts";
export function createInspectMemoryTool(
  action: ReturnType<typeof createInspectMemoryAction>,
): ToolResource<"inspect_memory"> {
  return defineTool("inspect_memory", action, {
    name: "Inspect Memory",
    description:
      "Inspect one accessible semantic memory, its provenance, time, and graph relations.",
  });
}
