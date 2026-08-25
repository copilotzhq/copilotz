/**
 * Defines the data-only Restore File Version Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { restoreFileVersionAction } from "../../actions/restore-file-version/index.ts";

export const restoreFileVersionTool = defineTool(
  "restore_file_version",
  restoreFileVersionAction,
  {
    name: "Restore File Version",
    description:
      "Restore a file from a previously captured in-process snapshot.",
  },
);
