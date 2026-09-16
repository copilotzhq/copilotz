import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Run Command Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { runCommandAction } from "../../../actions/run-command/index.ts";

export const runCommandTool: ToolDefinition<typeof runCommandAction> =
  defineTool({
    ...runCommandAction,
    ...{
      name: "Run Command",
      description: "Execute a system command safely with timeout protection.",
    },
  });

export default runCommandTool;
