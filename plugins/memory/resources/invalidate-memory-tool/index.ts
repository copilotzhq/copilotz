/** Tool resource exposing editorial invalidation for semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import type { createInvalidateMemoryAction } from "../../actions/invalidate-memory/index.ts";

export function createInvalidateMemoryTool(
  action: ReturnType<typeof createInvalidateMemoryAction>,
): ToolResource<"invalidate_memory"> {
  return defineTool("invalidate_memory", action, {
    name: "Invalidate Memory",
    description:
      "Retract, supersede, or archive one accessible memory while preserving the lifecycle of what it describes.",
  });
}
