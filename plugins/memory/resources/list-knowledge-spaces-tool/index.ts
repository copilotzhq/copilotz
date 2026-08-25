/** Tool resource exposing visible memory spaces. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import type { createListKnowledgeSpacesAction } from "../../actions/list-knowledge-spaces/index.ts";
export function createListKnowledgeSpacesTool(
  action: ReturnType<typeof createListKnowledgeSpacesAction>,
): ToolResource<"list_knowledge_spaces"> {
  return defineTool("list_knowledge_spaces", action, {
    name: "List Knowledge Spaces",
    description: "List durable memory spaces visible in the active tenant.",
  });
}
