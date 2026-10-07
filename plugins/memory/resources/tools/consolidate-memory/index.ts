import { consolidateMemoryAction } from "../../../actions/consolidate-memory/index.ts";
/** Tool resource exposing semantic-memory consolidation to an LLM. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";
import { CONSOLIDATE_MEMORY_ACTION_ID } from "../../../actions/consolidate-memory/index.ts";

export const consolidateMemoryTool: ToolResource<"consolidate_memory"> =
  defineTool("consolidate_memory", consolidateMemoryAction, {
    name: "Consolidate Memory",
    description:
      "Save replacement conversation continuity and optional durable notes. Correct active notes with replaces; retire wrong or irrelevant notes with a reason. Writes use the current trusted scope. Optional sources must be supplied evidence handles. Continuity alone is valid when no notes need changing.",
    history: { visibility: "requester_only" },
  });
export { CONSOLIDATE_MEMORY_ACTION_ID };

export default consolidateMemoryTool;
