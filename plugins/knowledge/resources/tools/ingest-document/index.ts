import type { ToolDefinition } from "@copilotz/copilotz/core";
import { defineTool } from "@copilotz/copilotz/core";
import { ingestKnowledgeDocumentAction } from "../../../actions/ingest-document/index.ts";
export const ingestKnowledgeDocumentTool: ToolDefinition<
  typeof ingestKnowledgeDocumentAction
> = defineTool({
  ...ingestKnowledgeDocumentAction,
  name: "Ingest Document",
  description:
    "Add text, a URL, an adapted file path, or an asset to the knowledge base. Indexing continues as durable background work.",
});

export default ingestKnowledgeDocumentTool;
