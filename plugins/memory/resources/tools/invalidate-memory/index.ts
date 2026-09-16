import { invalidateMemoryAction } from "../../../actions/invalidate-memory/index.ts";
/** Tool resource exposing editorial invalidation for semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";

export const invalidateMemoryTool: ToolResource<"invalidate_memory"> =
  defineTool("invalidate_memory", invalidateMemoryAction, {
    name: "Invalidate Memory",
    description:
      "Retract, supersede, or archive one accessible memory while preserving the lifecycle of what it describes.",
  });

export default invalidateMemoryTool;
