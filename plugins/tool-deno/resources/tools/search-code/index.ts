import type { ToolDefinition } from "@copilotz/copilotz/tools";
/**
 * Defines the data-only Search Code Tool Resource.
 *
 * @module
 */

import { defineTool } from "@copilotz/copilotz/tools";
import { searchCodeAction } from "../../../actions/search-code/index.ts";

export const searchCodeTool: ToolDefinition<typeof searchCodeAction> =
  defineTool({
    ...searchCodeAction,
    ...{
      name: "Search Code",
      description:
        "Search file contents in the current workspace and return line-level matches. Common noise directories (node_modules, .git, dist, etc.) are excluded by default. Narrow searches with directory and filePattern for faster, cleaner results.",
    },
  });

export default searchCodeTool;
