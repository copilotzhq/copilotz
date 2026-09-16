import type { ToolDefinition } from "@copilotz/copilotz/core";
import { defineTool } from "@copilotz/copilotz/core";
import { searchKnowledgeAction } from "../../../actions/search-knowledge/index.ts";
export const searchKnowledgeTool: ToolDefinition<typeof searchKnowledgeAction> =
  defineTool({
    ...searchKnowledgeAction,
    name: "Search Knowledge Base",
    description:
      "Search indexed chunks by semantic similarity within the current tenant and graph scope.",
  });

export default searchKnowledgeTool;
