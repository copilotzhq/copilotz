/** Completes a deferred Ask branch from its canonical answer Message. @module */

import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../internal/runtime-context.ts";
import { agentAskMetadata } from "../../internal/workflow-metadata.ts";
import { resumeDeferredToolPlan } from "../../internal/tool-plan.ts";
import {
  asRecord,
  collectionEventRecord,
  requireCollection,
} from "../internal/helpers.ts";

export const completeAskProcessor: Processor<CoreToolProcessorContext> =
  defineProcessor<CoreToolProcessorContext>({
    id: "copilotz.core.complete-agent-ask",
    on: [{
      eventType: "message.created",
      metadata: { copilotzAsk: { phase: "answer" } },
    }],
    async handle(event, context) {
      const message = collectionEventRecord(event);
      const sender = await requireCollection(context, "participant").get({
        id: String(message.senderId),
      });
      if (!sender) {
        throw new Error(`Ask answer '${message.id}' sender was not found.`);
      }
      const ask = agentAskMetadata(asRecord(message.metadata));
      if (!ask || ask.phase !== "answer") return;
      if (sender.id !== ask.askedParticipantId) return;
      await resumeDeferredToolPlan(context, ask, {
        status: "completed",
        /** Pipeline value is the canonical content; receipt provenance is separate. */
        output: structuredClone(message.content),
        askResult: {
          schema: "copilotz.ask-result.v1",
          askId: ask.askId,
          status: "completed",
          askedParticipantId: ask.askedParticipantId,
          askedAgentId: ask.askedAgentId,
          answerMessageId: String(message.id),
        },
      });
    },
  });
