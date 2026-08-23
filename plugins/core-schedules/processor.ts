import type { ActionCaller } from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type { dispatchScheduledMessageAction } from "./action.ts";
import { coreScheduledMessageOccurrence } from "./message.ts";
import { CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE } from "./types.ts";

type CoreSchedulesProcessorContext =
  & Omit<ProcessorContext, "actions">
  & Readonly<{
    actions: Readonly<{
      dispatchScheduledMessage: ActionCaller<
        typeof dispatchScheduledMessageAction
      >;
    }>;
  }>;

export const dispatchScheduledMessageProcessor: Processor<
  CoreSchedulesProcessorContext
> = defineProcessor({
  id: "core-schedules.dispatch-message",
  on: [{
    eventType: "scheduled_job.due",
    data: {
      record: {
        payload: { type: CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE },
      },
    },
  }],
  async handle(event, context) {
    if (!event.durable) return;
    const occurrence = coreScheduledMessageOccurrence(event);
    await context.actions.dispatchScheduledMessage(occurrence, {
      operationKey: `dispatch:${occurrence.occurrenceId}`,
    });
  },
});
