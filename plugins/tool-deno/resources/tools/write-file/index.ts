import type { ToolDefinition } from "@copilotz/copilotz/tools";
/**
 * Defines the data-only Write File Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { writeFileAction } from "../../../actions/write-file/index.ts";

export const writeFileTool: ToolDefinition<typeof writeFileAction> = defineTool(
  {
    ...writeFileAction,
    ...{
      name: "Write File",
      description:
        "Write or append UTF-8 text inside the current workspace, capturing a restorable snapshot before edits. Use apply_patch instead when modifying an existing file.",
    },
  },
);

export default writeFileTool;
