/** Resumes the original recipient after a awaiting context checkpoint settles. @module */

import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { COMPACT_CONTEXT_ACTION_ID } from "../../actions/compact-context/index.ts";
import { asRecord, requiredText } from "../../shared/helpers.ts";
import type { CoreProcessorContext } from "../../shared/runtime-context.ts";
import { messageRouterProcessor } from "../message-router/index.ts";

export const resumeCompactionRouteProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.resume-compaction-route",
    on: [{
      eventType: `${COMPACT_CONTEXT_ACTION_ID}.completed`,
      data: { status: "completed" },
    }],
    async handle(event, context) {
      if (!event.durable) return;
      const receipt = parseActionLifecycleEvent(event, {
        actionId: COMPACT_CONTEXT_ACTION_ID,
        statuses: ["completed"],
      });
      if (!receipt || receipt.status !== "completed") return;
      const output = asRecord(receipt.output);
      if (output.resume !== true) return;

      const input = asRecord(receipt.input);
      const threadId = requiredText(input.threadId, "compaction thread id");
      const participantId = requiredText(
        input.participantId,
        "compaction participant id",
      );
      const triggerMessageId = requiredText(
        input.triggerMessageId,
        "compaction trigger message id",
      );
      const message = await context.collections.message?.get({
        id: triggerMessageId,
      });
      if (!message || String(message.threadId) !== threadId) {
        throw new Error(
          "The original message for compaction could not be restored.",
        );
      }

      const triggerEventId = typeof input.triggerEventId === "string"
        ? input.triggerEventId
        : triggerMessageId;
      const correlationId = typeof input.routeCorrelationId === "string"
        ? input.routeCorrelationId
        : event.correlationId ?? triggerMessageId;
      await messageRouterProcessor.handle({
        ...event,
        id: triggerEventId,
        type: "message.created",
        correlationId,
        durable: true,
        subject: { type: "message", id: triggerMessageId },
        metadata: {
          core: {
            threadId,
            routing: {
              senderId: String(message.senderId),
              recipientIds: [participantId],
            },
            visibility: message.visibility ?? { kind: "public" },
          },
        },
        data: { record: message },
      }, context);
    },
  });

export default resumeCompactionRouteProcessor;
