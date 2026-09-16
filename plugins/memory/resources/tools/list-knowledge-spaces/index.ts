import { listKnowledgeSpacesAction } from "../../../actions/list-knowledge-spaces/index.ts";
/** Tool resource exposing visible memory spaces. @module */
import { defineTool, type ToolResource } from "@copilotz/copilotz/core";

export const listKnowledgeSpacesTool: ToolResource<"list_knowledge_spaces"> =
  defineTool("list_knowledge_spaces", listKnowledgeSpacesAction, {
    name: "List Knowledge Spaces",
    description: "List durable memory spaces visible in the active tenant.",
  });

export default listKnowledgeSpacesTool;
