/**
 * Defines the Action behind the Core `scheduled_jobs` Tool Resource.
 *
 * @module
 */

import {
  type ActionCaller,
  type ActionContext,
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  ContentInput,
  DurableContentInput,
} from "@copilotz/copilotz/content";
import {
  createScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  type runScheduledJobNowAction,
  type ScheduledJob,
  type ScheduledJobSchedule,
  type ScheduledJobStatus,
  updateScheduledJob,
} from "../../../schedules/index.ts";
import {
  normalizeCoreScheduledMessagePayload,
  scheduledMessageJob,
} from "../../authoring/scheduled-message/index.ts";
import type {
  CoreScheduledMessageInput,
  CoreScheduledMessagePayload,
  CoreScheduledMessageSender,
  CoreScheduledMessageThread,
} from "../../internal/contracts.ts";
import type { CoreResources } from "../../../core/internal/runtime-context.ts";
import { coreToolActionMetadata } from "../../../core/internal/workflow-metadata.ts";
import {
  resolveScheduledRecipientSelection,
  type ScheduledRecipientSelection,
} from "../../internal/recipients.ts";

type ScheduledJobsToolAction =
  | "create"
  | "get"
  | "list"
  | "update"
  | "pause"
  | "resume"
  | "cancel"
  | "run_now";

type ScheduledJobsActionContext = ActionContext<
  CoreResources,
  ActionContext["adapters"],
  Readonly<{
    runScheduledJobNow: ActionCaller<typeof runScheduledJobNowAction>;
  }>
>;

type ParsedMessage = Readonly<{
  thread?: CoreScheduledMessageThread;
  sender?: CoreScheduledMessageSender;
  recipients?: ScheduledRecipientSelection;
  content?: ContentInput | readonly ContentInput[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

type PreparedMessage =
  & Omit<ParsedMessage, "content">
  & Readonly<{ content?: DurableContentInput }>;

type ResolvedMessage =
  & Omit<PreparedMessage, "recipients">
  & Readonly<{ recipientIds?: readonly string[] }>;

function record(value: unknown, name = "Input"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be non-empty.`);
  }
  return value.trim();
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredText(value, name);
}

function selectedAction(value: unknown): ScheduledJobsToolAction {
  const normalized = requiredText(value, "Scheduled jobs action");
  if (
    normalized === "create" || normalized === "get" ||
    normalized === "list" || normalized === "update" ||
    normalized === "pause" || normalized === "resume" ||
    normalized === "cancel" || normalized === "run_now"
  ) return normalized;
  throw new TypeError(`Unsupported scheduled jobs action '${normalized}'.`);
}

function jobStatus(value: unknown): ScheduledJobStatus {
  if (value === "active" || value === "paused" || value === "cancelled") {
    return value;
  }
  throw new TypeError(`Invalid scheduled job status '${String(value)}'.`);
}

function schedule(value: unknown): ScheduledJobSchedule {
  const input = record(value, "Schedule");
  if (input.type !== undefined && input.type !== "cron") {
    throw new TypeError(
      "Scheduled jobs currently support cron schedules only.",
    );
  }
  return Object.freeze({
    type: "cron",
    expression: requiredText(input.expression, "Cron expression"),
    ...(optionalText(input.timezone, "Cron timezone")
      ? { timezone: optionalText(input.timezone, "Cron timezone") }
      : {}),
  });
}

function stringList(
  value: unknown,
  name: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array.`);
  return Object.freeze(value.map((item) => requiredText(item, name)));
}

function recipients(
  value: unknown,
): ScheduledRecipientSelection | undefined {
  if (value === undefined) return undefined;
  if (value === "caller" || value === "all") return value;
  const values = stringList(value, "Scheduled recipient");
  if (!values?.length) {
    throw new TypeError(
      "Scheduled recipients must contain at least one value.",
    );
  }
  return Object.freeze([...new Set(values)]);
}

function thread(value: unknown): CoreScheduledMessageThread | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Scheduled thread");
  const metadata = input.metadata === undefined
    ? undefined
    : structuredClone(record(input.metadata, "Scheduled thread metadata"));
  return Object.freeze({
    ...(optionalText(input.id, "Scheduled thread ID")
      ? { id: optionalText(input.id, "Scheduled thread ID") }
      : {}),
    ...(optionalText(input.externalId, "Scheduled thread external ID")
      ? {
        externalId: optionalText(
          input.externalId,
          "Scheduled thread external ID",
        ),
      }
      : {}),
    ...(optionalText(input.status, "Scheduled thread status")
      ? { status: optionalText(input.status, "Scheduled thread status") }
      : {}),
    ...(metadata ? { metadata } : {}),
  });
}

function sender(value: unknown): CoreScheduledMessageSender | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Scheduled sender");
  return Object.freeze({
    ...(optionalText(input.id, "Scheduled sender ID")
      ? { id: optionalText(input.id, "Scheduled sender ID") }
      : {}),
    externalId: requiredText(
      input.externalId ?? input.id,
      "Scheduled sender external ID",
    ),
    ...(optionalText(input.name, "Scheduled sender name")
      ? { name: optionalText(input.name, "Scheduled sender name") }
      : {}),
    ...(optionalText(input.email, "Scheduled sender email")
      ? { email: optionalText(input.email, "Scheduled sender email") }
      : {}),
    ...(input.metadata === undefined ? {} : {
      metadata: structuredClone(
        record(input.metadata, "Scheduled sender metadata"),
      ),
    }),
  });
}

function message(
  value: unknown,
  options: { partial: boolean; defaultThreadId?: string },
): ParsedMessage {
  const input = record(value, "Scheduled run");
  if (!options.partial && input.content === undefined) {
    throw new TypeError("Scheduled run content is required.");
  }
  const targetThread = thread(input.thread) ??
    (options.defaultThreadId ? { id: options.defaultThreadId } : undefined);
  return Object.freeze({
    ...(input.content === undefined ? {} : {
      content: structuredClone(input.content) as
        | ContentInput
        | readonly ContentInput[],
    }),
    ...(targetThread ? { thread: targetThread } : {}),
    ...(input.sender === undefined ? {} : { sender: sender(input.sender) }),
    ...(input.recipients === undefined
      ? {}
      : { recipients: recipients(input.recipients) }),
    ...(input.metadata === undefined ? {} : {
      metadata: structuredClone(
        record(input.metadata, "Scheduled run metadata"),
      ),
    }),
  });
}

async function prepareMessageContent(
  input: ParsedMessage,
  context: ScheduledJobsActionContext,
  operationKey: string,
): Promise<PreparedMessage> {
  const { content, ...message } = input;
  if (content === undefined) return Object.freeze(message);
  return Object.freeze({
    ...message,
    content: await context.content.prepare(content, {
      operationKey: `${operationKey}:content`,
    }),
  });
}

async function resolveMessageRecipients(
  message: PreparedMessage,
  context: ScheduledJobsActionContext,
  defaultToCaller: boolean,
): Promise<ResolvedMessage> {
  const { recipients: selection, ...rest } = message;
  const selected = selection ?? (defaultToCaller ? "caller" : undefined);
  return Object.freeze({
    ...rest,
    ...(selected
      ? {
        recipientIds: await resolveScheduledRecipientSelection(
          selected,
          message.thread,
          context,
        ),
      }
      : {}),
  });
}

function positiveLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 100) {
    throw new TypeError("Scheduled job list limit must be between 1 and 100.");
  }
  return number;
}

function coreJob(
  value: ScheduledJob | null,
  id?: string,
): ScheduledJob<CoreScheduledMessagePayload> | null {
  if (!value) return null;
  try {
    const payload = normalizeCoreScheduledMessagePayload(value.payload);
    return Object.freeze({ ...value, payload });
  } catch {
    if (id) throw new Error(`Core scheduled message '${id}' was not found.`);
    return null;
  }
}

const scheduleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", const: "cron", default: "cron" },
    expression: {
      type: "string",
      description: "Standard cron expression, for example '0 9 * * 1'.",
    },
    timezone: {
      type: "string",
      description: "Optional IANA timezone such as America/Sao_Paulo.",
    },
  },
  required: ["expression"],
} as const;

const runSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: {
      description: "Text, JSON, or canonical text/media content parts.",
      anyOf: [
        { type: "string" },
        { type: "object", additionalProperties: true },
        {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      ],
    },
    thread: {
      type: "object",
      additionalProperties: true,
      description: "Existing thread id/externalId or a new thread descriptor.",
    },
    sender: {
      type: "object",
      additionalProperties: true,
      description: "Optional public job participant descriptor.",
    },
    recipients: {
      description:
        "Defaults to the calling Agent; use 'all' or a non-empty list of participant/Agent identities to override it.",
      oneOf: [
        { type: "string", enum: ["caller", "all"], default: "caller" },
        {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
      ],
    },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

const scheduledJobsInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "create",
        "get",
        "list",
        "update",
        "pause",
        "resume",
        "cancel",
        "run_now",
      ],
    },
    jobId: { type: "string" },
    name: { type: "string" },
    status: {
      type: "string",
      enum: ["active", "paused", "cancelled"],
    },
    schedule: scheduleSchema,
    run: runSchema,
    metadata: { type: "object", additionalProperties: true },
    threadId: { type: "string" },
    after: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
  required: ["action"],
} as const;

/** Native capability used by the matching `scheduled_jobs` Tool Resource. */
export const scheduledJobsAction: ActionDefinition<
  unknown,
  unknown,
  ScheduledJobsActionContext,
  ActionSchema,
  undefined
> = defineAction<
  unknown,
  unknown,
  ScheduledJobsActionContext,
  ActionSchema
>({
  id: "copilotz.core-schedules.scheduled-jobs",
  inputSchema: scheduledJobsInputSchema,
  async execute(raw, context) {
    const input = record(raw);
    const action = selectedAction(input.action);
    const operation = `${context.operationKey}:${action}`;
    const toolMetadata = coreToolActionMetadata(context.action.metadata);
    const defaultThreadId = toolMetadata?.threadId ??
      (typeof context.action.metadata.threadId === "string" &&
          context.action.metadata.threadId.trim()
        ? context.action.metadata.threadId.trim()
        : undefined);
    if (action === "create") {
      const resolved = await resolveMessageRecipients(
        await prepareMessageContent(
          message(input.run, {
            partial: false,
            defaultThreadId,
          }),
          context,
          operation,
        ),
        context,
        true,
      );
      const { recipientIds, content, ...messageFields } = resolved;
      if (!recipientIds?.length || !content) {
        throw new TypeError(
          "A scheduled message requires content and recipients.",
        );
      }
      const scheduledMessage: CoreScheduledMessageInput = Object.freeze({
        ...messageFields,
        recipients: recipientIds,
        content,
      });
      const job = await createScheduledJob(
        scheduledMessageJob({
          ...(optionalText(input.jobId, "Scheduled job ID")
            ? { id: optionalText(input.jobId, "Scheduled job ID") }
            : {}),
          name: requiredText(input.name, "Scheduled job name"),
          status: input.status === undefined
            ? "active"
            : jobStatus(input.status) === "cancelled"
            ? (() => {
              throw new TypeError("A new scheduled job cannot be cancelled.");
            })()
            : jobStatus(input.status) as "active" | "paused",
          schedule: schedule(input.schedule),
          message: scheduledMessage,
          ...(input.metadata === undefined ? {} : {
            metadata: structuredClone(
              record(input.metadata, "Scheduled job metadata"),
            ),
          }),
        }),
        context,
      );
      return { job };
    }

    if (action === "list") {
      const jobs = await listScheduledJobs({
        ...(input.status === undefined
          ? {}
          : { status: jobStatus(input.status) }),
        ...(optionalText(input.after, "Scheduled job cursor")
          ? { after: optionalText(input.after, "Scheduled job cursor") }
          : {}),
        ...(positiveLimit(input.limit)
          ? { limit: positiveLimit(input.limit) }
          : {}),
      }, context);
      const threadId = optionalText(input.threadId, "Scheduled thread ID");
      return {
        jobs: jobs
          .map((job) => coreJob(job))
          .filter((job): job is ScheduledJob<CoreScheduledMessagePayload> =>
            job !== null
          )
          .filter((job) =>
            !threadId || job.payload.thread?.id === threadId ||
            job.payload.thread?.externalId === threadId
          ),
      };
    }

    const jobId = requiredText(input.jobId, "Scheduled job ID");
    const existing = coreJob(
      await getScheduledJob({ id: jobId }, context),
      jobId,
    );
    if (!existing) {
      throw new Error(`Core scheduled message '${jobId}' was not found.`);
    }
    if (action === "get") return { job: existing };
    if (action === "pause" || action === "resume" || action === "cancel") {
      const status = action === "pause"
        ? "paused"
        : action === "resume"
        ? "active"
        : "cancelled";
      return {
        job: await updateScheduledJob(
          { id: jobId, patch: { status } },
          context,
        ),
      };
    }
    if (action === "run_now") {
      return await context.actions.runScheduledJobNow({ id: jobId }, {
        operationKey: `${operation}:run`,
        signal: context.signal,
      });
    }

    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      patch.name = requiredText(input.name, "Scheduled job name");
    }
    if (input.status !== undefined) patch.status = jobStatus(input.status);
    if (input.schedule !== undefined) patch.schedule = schedule(input.schedule);
    if (input.run !== undefined) {
      const resolved = await resolveMessageRecipients(
        await prepareMessageContent(
          message(input.run, { partial: true }),
          context,
          operation,
        ),
        context,
        false,
      );
      const { content, ...payloadFields } = resolved;
      if (Object.keys(payloadFields).length) {
        patch.payload = normalizeCoreScheduledMessagePayload({
          ...structuredClone(existing.payload),
          ...payloadFields,
        });
      }
      if (content !== undefined) patch.content = content;
    }
    if (input.metadata !== undefined) {
      patch.metadata = structuredClone(
        record(input.metadata, "Scheduled job metadata"),
      );
    }
    if (Object.keys(patch).length === 0) {
      throw new TypeError("Scheduled job update requires at least one field.");
    }
    return {
      job: await updateScheduledJob(
        { id: jobId, patch },
        context,
      ),
    };
  },
});
