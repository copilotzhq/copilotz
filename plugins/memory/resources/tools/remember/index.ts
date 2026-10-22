/** Memory tool. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";
import { rememberAction } from "../../../actions/remember/index.ts";
const tool: ToolResource<"remember"> = defineTool("remember", rememberAction, {
  history: { visibility: "requester_only" },
  name: "Remember",
  description:
    "Save one fact immediately. Choose personal for the initiating human, space for all threads currently in this Core space, or thread (default) for conversation continuity. Use replaces to correct an item.",
});
export default tool;
