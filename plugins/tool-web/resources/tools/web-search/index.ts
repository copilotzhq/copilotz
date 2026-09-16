import type { ToolDefinition } from "@copilotz/copilotz/core";
/**
 * Defines the data-only Tool Resource for web search.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/core";
import { webSearchAction } from "../../../actions/web-search/index.ts";

export const webSearchTool: ToolDefinition<typeof webSearchAction> = defineTool(
  {
    ...webSearchAction,
    ...{
      name: "Web Search",
      description:
        "Search the web and return structured page results. Use this to find relevant pages before fetching a specific URL.",
    },
  },
);

export default webSearchTool;
