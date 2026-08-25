/** Reacts to document creation by starting durable indexing. @module */

import { isSettledActionError } from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import { KNOWLEDGE_DOCUMENT_COLLECTION } from "../../collections/index.ts";
import type { KnowledgeIndexActionCallers } from "../../actions/index.ts";

export const INDEX_KNOWLEDGE_DOCUMENT_PROCESSOR_ID =
  "copilotz.knowledge.index-document";

export type KnowledgeIndexDocumentProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{ actions: KnowledgeIndexActionCallers }>;

/** Starts the index action after a new document mutation settles. */
export const indexKnowledgeDocumentProcessor: Processor<
  KnowledgeIndexDocumentProcessorContext
> = defineProcessor<KnowledgeIndexDocumentProcessorContext>({
  id: INDEX_KNOWLEDGE_DOCUMENT_PROCESSOR_ID,
  on: [{
    eventType: "document.created",
    subject: { type: KNOWLEDGE_DOCUMENT_COLLECTION },
  }],
  async handle(event, context) {
    if (!event.durable || !event.subject) return;
    try {
      await context.actions.indexKnowledgeDocument({ id: event.subject.id }, {
        operationKey: `index:${event.subject.id}`,
        identity: {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: event.deduplicationId,
          settlementScopeId: context.identity.settlementScopeId,
        },
        signal: context.signal,
      });
    } catch (error) {
      if (!isSettledActionError(error)) throw error;
    }
  },
});
