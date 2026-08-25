/** Tool resource exposing lifecycle transitions for semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import type { createSetMemoryStatusAction } from "../../actions/set-memory-status/index.ts";
export function createSetMemoryStatusTool(
  action: ReturnType<typeof createSetMemoryStatusAction>,
): ToolResource<"set_memory_status"> {
  return defineTool("set_memory_status", action, {
    name: "Set Memory Status",
    description:
      "Retract, close, complete, cancel, answer, obsolete, deprecate, or archive one accessible memory without erasing history.",
  });
}
