/**
 * Defines the data-only Read File Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { readFileAction } from "../../actions/read-file/index.ts";

export const readFileTool = defineTool("read_file", readFileAction, {
  name: "Read File",
  description:
    "Read a file from the current workspace, optionally limiting the response to a line range. Files over 300 lines are auto-truncated when no range is given. Files over 1MB require an explicit range. Output is capped at 100KB.",
});
