/**
 * Defines public helpers for authoring and reading Core scheduled messages.
 *
 * @module
 */

import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type { CollectionEventBody } from "@copilotz/copilotz/collections";
import type { ProcessorEvent } from "@copilotz/copilotz/plugins";
import type { ScheduledJobOccurrenceRef } from "../../../schedules/index.ts";
import {
  requireScheduledText,
  scheduledRecord,
} from "../../../schedules/internal/model.ts";
import {
  CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
  type CoreScheduledMessageJob,
  type CoreScheduledMessageJobInput,
  type CoreScheduledMessageOccurrence,
  type CoreScheduledMessagePayload,
} from "../../internal/contracts.ts";

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireScheduledText(value, name);
}

function optionalRecord(
  value: unknown,
  name: string,
): Readonly<Record<string, unknown>> | undefined {
  return value === undefined
    ? undefined
    : Object.freeze(structuredClone(scheduledRecord(value, name)));
}

function stringList(
  value: unknown,
  name: string,
): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  const values = [
    ...new Set(
      value.map((item) => requireScheduledText(item, name)),
    ),
  ];
  if (values.length === 0) {
    throw new TypeError(`${name} must contain at least one value.`);
  }
  return Object.freeze(values);
}

export function normalizeCoreScheduledMessagePayload(
  value: unknown,
): CoreScheduledMessagePayload {
  const input = scheduledRecord(value, "Core scheduled message payload");
  if (input.type !== CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE) {
    throw new TypeError("Scheduled job is not a Core scheduled message.");
  }
  const thread = optionalRecord(input.thread, "Scheduled message thread");
  const sender = optionalRecord(input.sender, "Scheduled message sender");
  const metadata = optionalRecord(
    input.metadata,
    "Scheduled message metadata",
  );
  return Object.freeze({
    type: CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
    ...(thread
      ? {
        thread: {
          ...(optionalText(thread.id, "Scheduled thread ID")
            ? { id: optionalText(thread.id, "Scheduled thread ID") }
            : {}),
          ...(optionalText(thread.externalId, "Scheduled thread external ID")
            ? {
              externalId: optionalText(
                thread.externalId,
                "Scheduled thread external ID",
              ),
            }
            : {}),
          ...(optionalText(thread.status, "Scheduled thread status")
            ? { status: optionalText(thread.status, "Scheduled thread status") }
            : {}),
          ...(optionalRecord(thread.metadata, "Scheduled thread metadata")
            ? {
              metadata: optionalRecord(
                thread.metadata,
                "Scheduled thread metadata",
              ),
            }
            : {}),
        },
      }
      : {}),
    ...(sender
      ? {
        sender: {
          ...(optionalText(sender.id, "Scheduled sender ID")
            ? { id: optionalText(sender.id, "Scheduled sender ID") }
            : {}),
          externalId: requireScheduledText(
            sender.externalId ?? sender.id,
            "Scheduled sender external ID",
          ),
          ...(optionalText(sender.name, "Scheduled sender name")
            ? { name: optionalText(sender.name, "Scheduled sender name") }
            : {}),
          ...(optionalText(sender.email, "Scheduled sender email")
            ? { email: optionalText(sender.email, "Scheduled sender email") }
            : {}),
          ...(optionalRecord(sender.metadata, "Scheduled sender metadata")
            ? {
              metadata: optionalRecord(
                sender.metadata,
                "Scheduled sender metadata",
              ),
            }
            : {}),
        },
      }
      : {}),
    recipientIds: stringList(
      input.recipientIds,
      "Scheduled recipient ID",
    ),
    ...(metadata ? { metadata } : {}),
  });
}

/** Optional typed helper; an equivalent plain job object remains valid. */
export function scheduledMessageJob(
  input: CoreScheduledMessageJobInput,
): CoreScheduledMessageJob {
  const message = input.message;
  const payload = normalizeCoreScheduledMessagePayload({
    type: CORE_SCHEDULED_MESSAGE_PAYLOAD_TYPE,
    ...(message.thread ? { thread: message.thread } : {}),
    ...(message.sender ? { sender: message.sender } : {}),
    recipientIds: message.recipients,
    ...(message.metadata ? { metadata: message.metadata } : {}),
  });
  return Object.freeze({
    ...(input.id?.trim() ? { id: input.id.trim() } : {}),
    name: requireScheduledText(input.name, "Scheduled job name"),
    ...(input.status ? { status: input.status } : {}),
    schedule: Object.freeze(structuredClone(input.schedule)),
    payload,
    content: structuredClone(message.content),
    ...(input.metadata ? { metadata: structuredClone(input.metadata) } : {}),
  });
}

function occurrenceRef(record: CollectionRecord): ScheduledJobOccurrenceRef {
  const value = scheduledRecord(
    record.lastOccurrence,
    "Scheduled job occurrence",
  );
  const mode = value.mode === "manual"
    ? "manual"
    : value.mode === "scheduled"
    ? "scheduled"
    : undefined;
  if (!mode) throw new TypeError("Scheduled occurrence mode is invalid.");
  return Object.freeze({
    id: requireScheduledText(value.id, "Scheduled occurrence ID"),
    mode,
    scheduledFor: requireScheduledText(
      value.scheduledFor,
      "Scheduled occurrence time",
    ),
  });
}

export function coreScheduledMessageOccurrence(
  event: ProcessorEvent,
): CoreScheduledMessageOccurrence {
  const body = event.data as Partial<CollectionEventBody<CollectionRecord>>;
  if (!body || typeof body !== "object" || !body.record) {
    throw new TypeError("Scheduled due event data must include a job record.");
  }
  const record = body.record;
  const occurrence = occurrenceRef(record);
  if (record.content !== undefined && !Array.isArray(record.content)) {
    throw new TypeError("Scheduled message content must be canonical refs.");
  }
  return Object.freeze({
    jobId: requireScheduledText(record.id, "Scheduled job ID"),
    jobName: requireScheduledText(record.name, "Scheduled job name"),
    occurrenceId: occurrence.id,
    mode: occurrence.mode,
    scheduledFor: occurrence.scheduledFor,
    payload: normalizeCoreScheduledMessagePayload(record.payload),
    ...(Array.isArray(record.content)
      ? {
        content: Object.freeze(
          structuredClone(record.content),
        ) as ContentSequence,
      }
      : {}),
    metadata: Object.freeze(structuredClone(
      record.metadata && typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : {},
    )),
  });
}
