import type { DurableContentInput } from "@copilotz/copilotz/content";
import type {
  CreateScheduledJobInput,
  ScheduledJobOccurrence,
  ScheduledJobPayload,
  ScheduledJobSchedule,
  ScheduledJobStatus,
} from "../schedules/index.ts";

export const CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE =
  "copilotz.core.scheduled-message";

export type CoreScheduledMessageThread = Readonly<{
  id?: string;
  externalId?: string;
  status?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CoreScheduledMessageSender = Readonly<{
  id?: string;
  externalId: string;
  name?: string;
  email?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CoreScheduledMessagePayload =
  & ScheduledJobPayload
  & Readonly<{
    type: typeof CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE;
    thread?: CoreScheduledMessageThread;
    sender?: CoreScheduledMessageSender;
    /** Participant IDs/external IDs or Core Agent Resource IDs. */
    recipientIds?: readonly string[];
    metadata?: Readonly<Record<string, unknown>>;
  }>;

export type CoreScheduledMessageInput = Readonly<{
  thread?: CoreScheduledMessageThread;
  sender?: CoreScheduledMessageSender;
  recipientIds?: readonly string[];
  content: DurableContentInput;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CoreScheduledMessageJobInput = Readonly<{
  id?: string;
  name: string;
  status?: Exclude<ScheduledJobStatus, "cancelled">;
  schedule: ScheduledJobSchedule;
  message: CoreScheduledMessageInput;
  metadata?: Readonly<Record<string, unknown>>;
}>;

export type CoreScheduledMessageOccurrence = ScheduledJobOccurrence<
  CoreScheduledMessagePayload
>;

export type CoreScheduledMessageJob = CreateScheduledJobInput<
  CoreScheduledMessagePayload
>;

export type DispatchScheduledMessageResult = Readonly<{
  messageId: string;
  threadId: string;
}>;
