import type { ToolDefinition } from "@copilotz/copilotz/tools";
import { defineTool } from "@copilotz/copilotz/tools";
import { deleteKnowledgeDocumentAction } from "../../../actions/delete-document/index.ts";
export const deleteKnowledgeDocumentTool: ToolDefinition<
  typeof deleteKnowledgeDocumentAction
> = defineTool({
  ...deleteKnowledgeDocumentAction,
  name: "Delete Document",
  description:
    "Remove one document and its chunks by document ID or source URI.",
});

export default deleteKnowledgeDocumentTool;
