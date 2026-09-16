import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Restore File Version Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { restoreFileVersionAction } from "../../../actions/restore-file-version/index.ts";

export const restoreFileVersionTool: ToolDefinition<
  typeof restoreFileVersionAction
> = defineTool({
  ...restoreFileVersionAction,
  ...{
    name: "Restore File Version",
    description:
      "Restore a file from a previously captured in-process snapshot.",
  },
});

export default restoreFileVersionTool;
