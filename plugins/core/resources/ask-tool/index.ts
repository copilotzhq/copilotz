/** Defines the data-only Ask Tool Resource over Core's Ask Action. @module */

import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import { askAction } from "../../actions/ask/index.ts";

export const askTool: ToolResource<"ask"> = defineTool("ask", askAction, {
  name: "Ask Agent",
  description:
    "Ask another agent and resume after its canonical answer. Defaults to public group conversation; use mode 'private' for a DM-like exchange limited to the asking and asked agents.",
  history: { visibility: "public_status" },
});
