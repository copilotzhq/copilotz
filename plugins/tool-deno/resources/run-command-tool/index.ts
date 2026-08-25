/**
 * Defines the data-only Run Command Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { runCommandAction } from "../../actions/run-command/index.ts";

export const runCommandTool = defineTool("run_command", runCommandAction, {
  name: "Run Command",
  description: "Execute a system command safely with timeout protection.",
});
