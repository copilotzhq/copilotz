/**
 * Defines the Processor that dispatches typed Core scheduled-message Events.
 *
 * @module
 */

import type { ActionCaller } from "@copilotz/copilotz/actions";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "@copilotz/copilotz/plugins";
import type { dispatchScheduledMessageAction } from "../../actions/dispatch-scheduled-message/index.ts";
import { coreScheduledMessageOccurrence } from "../../authoring/scheduled-message/index.ts";
import { CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE } from "../../internal/contracts.ts";

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
