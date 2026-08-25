/** Defines the configured Knowledge semantic-search action. @module */

import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type KnowledgeActionContext,
  SEARCH_KNOWLEDGE_ACTION_ID,
  searchKnowledge,
  type SearchKnowledgeActionInput,
  type SearchKnowledgeActionResult,
  searchKnowledgeInputSchema,
  searchKnowledgeOutputSchema,
} from "../internal/operations.ts";
import type { KnowledgeEmbeddingConfig } from "../../internal/types.ts";

export { SEARCH_KNOWLEDGE_ACTION_ID };
export type { SearchKnowledgeActionInput, SearchKnowledgeActionResult };

/** Creates one provider-configured action for searching indexed documents. */
export function createSearchKnowledgeAction(
  embedding: KnowledgeEmbeddingConfig,
): ActionDefinition<
  SearchKnowledgeActionInput,
  SearchKnowledgeActionResult,
  KnowledgeActionContext,
  typeof searchKnowledgeInputSchema,
  typeof searchKnowledgeOutputSchema
> {
  return defineAction<
    SearchKnowledgeActionInput,
    SearchKnowledgeActionResult,
    KnowledgeActionContext,
    typeof searchKnowledgeInputSchema,
    typeof searchKnowledgeOutputSchema
  >({
    id: SEARCH_KNOWLEDGE_ACTION_ID,
    inputSchema: searchKnowledgeInputSchema,
    outputSchema: searchKnowledgeOutputSchema,
    async execute(input, context) {
      return await searchKnowledge(input, context, embedding);
    },
  });
}

export type SearchKnowledgeAction = ReturnType<
  typeof createSearchKnowledgeAction
>;
