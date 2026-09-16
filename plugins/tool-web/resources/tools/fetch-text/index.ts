import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Tool Resource for fetching text.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { fetchTextAction } from "../../../actions/fetch-text/index.ts";

export const fetchTextTool: ToolDefinition<typeof fetchTextAction> = defineTool(
  {
    ...fetchTextAction,
    ...{
      name: "Fetch Text",
      description:
        "Fetch text content from a URL and optionally filter or extract relevant text.",
    },
  },
);

export default fetchTextTool;
