import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import type { CoreToolProcessorContext } from "../../context.ts";
import { agentAskMetadata } from "../../internal/workflow-metadata.ts";
import { resumeDeferredToolPlan } from "../../internal/tool-plan.ts";
import {
  asRecord,
  collectionEventRecord,
  requireCollection,
} from "./helpers.ts";

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
        output: Object.freeze({
          status: "answered",
          askId: ask.askId,
          questionMessageId: ask.questionMessageId,
          answerMessageId: message.id,
          askedAgentId: ask.askedAgentId,
          askedParticipantId: ask.askedParticipantId,
        }),
      });
    },
  });
