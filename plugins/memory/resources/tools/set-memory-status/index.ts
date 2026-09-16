import { setMemoryStatusAction } from "../../../actions/set-memory-status/index.ts";
/** Tool resource exposing lifecycle transitions for semantic memory. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";

export const setMemoryStatusTool: ToolResource<"set_memory_status"> =
  defineTool("set_memory_status", setMemoryStatusAction, {
    name: "Set Memory Status",
    description:
      "Change the lifecycle status of one accessible memory without erasing history. For editorial retraction, supersession, or archival, use invalidate_memory.",
  });

export default setMemoryStatusTool;
