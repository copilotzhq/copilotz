import type { ContentInput, DurableContentInput } from "../content/index.ts";
import type {
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "../tools/index.ts";
import {
  createScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  updateScheduledJob,
} from "./lifecycle.ts";
import type {
  ScheduledJobSchedule,
  ScheduledJobSender,
  ScheduledJobStatus,
  ScheduledJobThread,
} from "./types.ts";

type ScheduledJobToolRunInput = Readonly<{
  thread?: ScheduledJobThread;
  sender?: ScheduledJobSender;
  recipientIds?: readonly string[];
  content: ContentInput | readonly ContentInput[];
  metadata?: Record<string, unknown>;
}>;

type ScheduledJobsAction =
  | "create"
  | "get"
  | "list"
  | "update"
  | "pause"
  | "resume"
  | "cancel"
  | "run_now";

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

function action(value: unknown): ScheduledJobsAction {
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

function thread(value: unknown): ScheduledJobThread | undefined {
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

function sender(value: unknown): ScheduledJobSender | undefined {
  if (value === undefined) return undefined;
  const input = record(value, "Scheduled sender");
  const externalId = requiredText(
    input.externalId ?? input.id,
    "Scheduled sender external ID",
  );
  return Object.freeze({
    ...(optionalText(input.id, "Scheduled sender ID")
      ? { id: optionalText(input.id, "Scheduled sender ID") }
      : {}),
    externalId,
    participantType: "job",
    ...(optionalText(input.name, "Scheduled sender name")
      ? { name: optionalText(input.name, "Scheduled sender name") }
      : {}),
    ...(optionalText(input.email, "Scheduled sender email")
      ? { email: optionalText(input.email, "Scheduled sender email") }
      : {}),
    ...(input.metadata === undefined ? {} : {
      metadata: structuredClone(record(input.metadata, "Sender metadata")),
    }),
  });
}

function run(
  value: unknown,
  options: { partial: boolean; defaultThreadId?: string },
): Partial<ScheduledJobToolRunInput> & {
  content?: ScheduledJobToolRunInput["content"];
} {
  const input = record(value, "Scheduled run");
  if (!options.partial && input.content === undefined) {
    throw new TypeError("Scheduled run content is required.");
  }
  const content = input.content as
    | ContentInput
    | readonly ContentInput[]
    | undefined;
  const targetThread = thread(input.thread) ??
    (options.defaultThreadId ? { id: options.defaultThreadId } : undefined);
  return Object.freeze({
    ...(content === undefined ? {} : { content: structuredClone(content) }),
    ...(targetThread ? { thread: targetThread } : {}),
    ...(input.sender === undefined ? {} : { sender: sender(input.sender) }),
    ...(input.recipientIds === undefined ? {} : {
      recipientIds: stringList(
        input.recipientIds,
        "Scheduled recipient ID",
      ),
    }),
    ...(input.metadata === undefined ? {} : {
      metadata: structuredClone(
        record(input.metadata, "Scheduled run metadata"),
      ),
    }),
  });
}

function executionContext(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error("This tool requires an event-native Copilotz context.");
  }
  return value;
}

type PreparedScheduledJobToolRunInput =
  & Omit<Partial<ScheduledJobToolRunInput>, "content">
  & Readonly<{ content?: DurableContentInput }>;

async function prepareRunContent(
  input: Partial<ScheduledJobToolRunInput>,
  context: WorkflowToolExecutionContext,
  operationKey: string,
): Promise<PreparedScheduledJobToolRunInput> {
  if (input.content === undefined) {
    const { content: _content, ...withoutContent } = input;
    return Object.freeze(withoutContent);
  }
  const content = await context.processor.content.prepare(input.content, {
    operationKey: `${operationKey}:content`,
  });
  return Object.freeze({
    ...input,
    content,
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
    recipientIds: {
      type: "array",
      items: { type: "string" },
      description: "Participant identities or agent resource IDs.",
    },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

/** Creates the event-native scheduled-job lifecycle tool. */
export function createScheduledJobsTool(
  toolId = "scheduled_jobs",
): WorkflowTool {
  const id = requiredText(toolId, "Scheduled jobs tool ID");
  return Object.freeze({
    id,
    key: id,
    name: "Scheduled Jobs",
    description:
      "Create and manage recurring jobs that send public messages to Copilotz agents. Supports create, get, list, update, pause, resume, cancel, and run_now.",
    inputSchema: {
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
    },
    async execute(raw: unknown, value?: WorkflowToolExecutionContext) {
      const context = executionContext(value);
      const input = record(raw);
      const selected = action(input.action);
      const operation = `scheduled_jobs:${selected}`;
      if (selected === "create") {
        const preparedRun = await prepareRunContent(
          run(input.run, {
            partial: false,
            defaultThreadId: context.execution.threadId,
          }) as ScheduledJobToolRunInput,
          context,
          operation,
        );
        const job = await createScheduledJob({
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
          run: preparedRun as
            & Required<
              Pick<PreparedScheduledJobToolRunInput, "content">
            >
            & PreparedScheduledJobToolRunInput,
          ...(input.metadata === undefined ? {} : {
            metadata: structuredClone(
              record(input.metadata, "Scheduled job metadata"),
            ),
          }),
        }, context.processor);
        return { job };
      }

      if (selected === "list") {
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
        }, context.processor);
        const threadId = optionalText(input.threadId, "Scheduled thread ID");
        return {
          jobs: threadId
            ? jobs.filter((item) =>
              item.run.thread?.id === threadId ||
              item.run.thread?.externalId === threadId
            )
            : jobs,
        };
      }

      const jobId = requiredText(input.jobId, "Scheduled job ID");
      if (selected === "get") {
        return { job: await getScheduledJob({ id: jobId }, context.processor) };
      }
      if (
        selected === "pause" || selected === "resume" || selected === "cancel"
      ) {
        const status = selected === "pause"
          ? "paused"
          : selected === "resume"
          ? "active"
          : "cancelled";
        const job = await updateScheduledJob(
          { id: jobId, patch: { status } },
          context.processor,
        );
        return { job };
      }
      if (selected === "run_now") {
        if (!context.processor.schedules) {
          throw new Error("Scheduled run_now requires the schedule trigger.");
        }
        return await context.processor.schedules.runNow(jobId, {
          operationKey: operation,
        });
      }

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) {
        patch.name = requiredText(input.name, "Scheduled job name");
      }
      if (input.status !== undefined) patch.status = jobStatus(input.status);
      if (input.schedule !== undefined) {
        patch.schedule = schedule(input.schedule);
      }
      if (input.run !== undefined) {
        patch.run = await prepareRunContent(
          run(input.run, { partial: true }),
          context,
          operation,
        );
      }
      if (input.metadata !== undefined) {
        patch.metadata = structuredClone(
          record(input.metadata, "Scheduled job metadata"),
        );
      }
      if (Object.keys(patch).length === 0) {
        throw new TypeError(
          "Scheduled job update requires at least one field.",
        );
      }
      const job = await updateScheduledJob(
        {
          id: jobId,
          patch,
        },
        context.processor,
      );
      return { job };
    },
  });
}
