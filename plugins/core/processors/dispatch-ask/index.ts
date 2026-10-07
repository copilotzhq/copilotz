/** Starts the work registered atomically by an Ask Action handoff. @module */
import { parseActionLifecycleEvent } from "@copilotz/copilotz/actions";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { ASK_ACTION_ID, type AskWork } from "../../actions/ask/index.ts";
import type { CoreProcessorContext } from "../../shared/runtime-context.ts";

export const dispatchAskProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.dispatch-agent-ask",
    on: [{ eventType: `${ASK_ACTION_ID}.deferred` }],
    async handle(event, context) {
      if (!event.durable) return;
      const receipt = parseActionLifecycleEvent(event, {
        actionId: ASK_ACTION_ID,
        statuses: ["deferred"],
      });
      if (receipt?.status !== "deferred") {
        throw new TypeError("Invalid Ask handoff receipt.");
      }
      const { ask, question } = receipt.work as AskWork;
      if (
        !ask || ask.toolActionRunId !== receipt.actionRunId ||
        ask.questionMessageId !== question?.id
      ) {
        throw new Error("Ask handoff has an inconsistent question identity.");
      }
      await context.actions.createThreadMessage(question, {
        operationKey: `ask:${ask.askId}:question`,
        signal: context.signal,
      });
    },
  });
export default dispatchAskProcessor;
