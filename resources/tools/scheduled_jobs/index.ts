import { ulid } from "ulid";
import type { MessagePayload } from "@/types/index.ts";
import type { RunOptions } from "@/runtime/index.ts";
import { runThread } from "@/runtime/index.ts";
import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";
import {
  base64ToBytes,
  buildAssetRefForStore,
  isDataUrl,
  parseDataUrl,
} from "@/runtime/storage/assets.ts";
import {
  getNextScheduledRunAt,
  type ScheduledJobData,
  type ScheduledJobSchedule,
  type ScheduledJobStatus,
} from "@/runtime/scheduler/index.ts";
import { GRAPH_EDGE } from "@/runtime/graph/edges.ts";

type ScheduledJobsAction =
  | "create"
  | "list"
  | "update"
  | "pause"
  | "resume"
  | "cancel"
  | "run_now";

type ScheduledJobsParams = {
  action: ScheduledJobsAction;
  jobId?: string;
  name?: string;
  schedule?: ScheduledJobSchedule;
  run?: {
    message: MessagePayload;
    options?: RunOptions | null;
  };
  status?: ScheduledJobStatus;
  threadId?: string;
  metadata?: Record<string, unknown> | null;
};

type ScheduledJobCollection = {
  create: (
    data: Record<string, unknown>,
  ) => Promise<ScheduledJobData & { id: string }>;
  find: (
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Array<ScheduledJobData & { id: string }>>;
  findById: (id: string) => Promise<(ScheduledJobData & { id: string }) | null>;
  update: (
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
};

type CreatedAsset = {
  assetId: string;
  ref: string;
  mime: string;
  kind: "image" | "audio" | "file";
  size: number;
};

type MessageContentPart = Extract<MessagePayload["content"], unknown[]>[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scheduleSchema = {
  type: "object",
  additionalProperties: false,
  description:
    "Cron schedule for the job. Use a standard 5-field cron expression and an IANA timezone.",
  properties: {
    type: {
      type: "string",
      const: "cron",
      description: "Only cron schedules are supported.",
    },
    expression: {
      type: "string",
      description:
        "Standard 5-field cron expression, e.g. '0 9 * * 1' for Mondays at 09:00.",
    },
    timezone: {
      type: "string",
      description:
        "IANA timezone for the cron expression. Defaults to UTC. Examples: 'UTC', 'America/Sao_Paulo'.",
      default: "UTC",
    },
  },
  required: ["type", "expression"],
} as const;

const contentPartSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    type: {
      type: "string",
      enum: ["text", "image", "audio", "file", "json"],
      description: "Message content part type.",
    },
    text: { type: "string", description: "Text for type='text'." },
    value: { description: "JSON value for type='json'." },
    url: {
      type: "string",
      description:
        "Media URL for image/audio/file parts. Prefer asset:// refs. data: URLs are accepted and saved as assets before the job is persisted.",
    },
    dataBase64: {
      type: "string",
      description:
        "Inline base64 media bytes. Requires mimeType and is saved as an asset before the job is persisted.",
    },
    mimeType: {
      type: "string",
      description: "MIME type for media parts, required with dataBase64.",
    },
    name: { type: "string", description: "File name for type='file'." },
    alt: { type: "string", description: "Alt text for type='image'." },
    transcript: {
      type: "string",
      description: "Transcript for type='audio'.",
    },
  },
  required: ["type"],
} as const;

const messageSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Message template passed to copilotz.run when the job fires. The tool stores it with sender.type='job'. If thread is omitted, the current thread is used.",
  properties: {
    content: {
      description:
        "Text or structured content to inject when the job runs. Write this like a clear user instruction to the target agent.",
      anyOf: [
        { type: "string" },
        { type: "array", items: contentPartSchema },
      ],
    },
    sender: {
      type: "object",
      additionalProperties: true,
      description:
        "Optional. The tool will persist this as sender.type='job'; omit it unless you need a custom job display name.",
      properties: {
        id: { type: "string" },
        externalId: { type: "string" },
        type: {
          type: "string",
          enum: ["job", "user", "agent", "tool", "system"],
          default: "job",
        },
        name: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    thread: {
      type: "object",
      additionalProperties: true,
      description:
        "Optional thread target. Omit to use the current thread, or pass {id} to schedule into a specific thread.",
      properties: {
        id: { type: "string" },
        externalId: { type: "string" },
        name: { type: "string" },
        participants: { type: "array", items: { type: "string" } },
        metadata: { type: "object", additionalProperties: true },
      },
    },
    target: {
      type: "string",
      description:
        "Optional agent or participant id/name to route this scheduled message to, e.g. 'north'.",
    },
    targetQueue: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional ordered route through multiple participants after target.",
    },
    toolCalls: {
      type: "array",
      description:
        "Optional structured tool calls. Use only when the scheduled job should directly execute tool calls instead of sending text.",
      items: {
        type: "object",
        additionalProperties: true,
        properties: {
          id: { type: "string" },
          tool: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
            },
            required: ["id"],
          },
          args: { description: "Tool arguments as an object or JSON string." },
        },
        required: ["tool", "args"],
      },
    },
    metadata: {
      type: "object",
      additionalProperties: true,
      description: "Optional metadata persisted on the generated job message.",
    },
  },
  anyOf: [
    { required: ["content"] },
    { required: ["toolCalls"] },
  ],
} as const;

const runSchema = {
  type: "object",
  additionalProperties: false,
  description:
    "Copilotz run template. When due, the scheduler calls copilotz.run(message, options).",
  properties: {
    message: messageSchema,
    options: {
      type: ["object", "null"],
      additionalProperties: false,
      description:
        "Optional copilotz.run options. Usually omit this. Scheduler owns traceId/eventMetadata/namespace.",
      properties: {
        stream: { type: "boolean", default: false },
        queueTTL: {
          type: "number",
          description: "Optional queue TTL in milliseconds.",
          minimum: 1,
        },
        ackMode: {
          type: "string",
          enum: ["immediate", "onComplete"],
        },
        schema: {
          type: "string",
          description: "Optional PostgreSQL schema override.",
        },
      },
    },
  },
  required: ["message"],
} as const;

const inputSchema = {
  type: "object",
  description:
    "Manage recurring scheduled Copilotz jobs. Pick exactly one action shape.",
  properties: {
    action: {
      type: "string",
      enum: [
        "create",
        "list",
        "update",
        "pause",
        "resume",
        "cancel",
        "run_now",
      ],
      description:
        "Lifecycle action. The required fields depend on this action.",
    },
    jobId: {
      type: "string",
      description:
        "Scheduled job id. Required for update, pause, resume, cancel, and run_now.",
    },
    name: {
      type: "string",
      description: "Human-readable job name for create/update.",
    },
    schedule: scheduleSchema,
    run: runSchema,
    status: {
      type: "string",
      enum: ["active", "paused", "cancelled"],
      description: "Job status filter or replacement status.",
    },
    threadId: {
      type: "string",
      description: "Optional thread id filter for list.",
    },
    metadata: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "Optional job metadata for create/update.",
    },
  },
  oneOf: [
    {
      title: "Create scheduled job",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "create" },
        name: { type: "string", description: "Human-readable job name." },
        schedule: scheduleSchema,
        run: runSchema,
        status: {
          type: "string",
          enum: ["active", "paused"],
          default: "active",
          description:
            "Initial status. Use paused to save without executing on ticks.",
        },
        metadata: {
          type: ["object", "null"],
          additionalProperties: true,
          description: "Optional metadata about why/who created the job.",
        },
      },
      required: ["action", "name", "schedule", "run"],
    },
    {
      title: "List scheduled jobs",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "list" },
        status: {
          type: "string",
          enum: ["active", "paused", "cancelled"],
          description: "Optional status filter.",
        },
        threadId: {
          type: "string",
          description:
            "Optional thread id filter. Omit to list jobs in the tenant namespace.",
        },
      },
      required: ["action"],
    },
    {
      title: "Update scheduled job",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "update" },
        jobId: { type: "string", description: "Scheduled job id." },
        name: { type: "string", description: "New job name." },
        schedule: scheduleSchema,
        run: runSchema,
        status: {
          type: "string",
          enum: ["active", "paused", "cancelled"],
          description: "New job status.",
        },
        metadata: {
          type: ["object", "null"],
          additionalProperties: true,
          description: "Replacement metadata object.",
        },
      },
      required: ["action", "jobId"],
      anyOf: [
        { required: ["name"] },
        { required: ["schedule"] },
        { required: ["run"] },
        { required: ["status"] },
        { required: ["metadata"] },
      ],
    },
    {
      title: "Pause scheduled job",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "pause" },
        jobId: { type: "string", description: "Scheduled job id." },
      },
      required: ["action", "jobId"],
    },
    {
      title: "Resume scheduled job",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "resume" },
        jobId: { type: "string", description: "Scheduled job id." },
      },
      required: ["action", "jobId"],
    },
    {
      title: "Cancel scheduled job",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "cancel" },
        jobId: { type: "string", description: "Scheduled job id." },
      },
      required: ["action", "jobId"],
    },
    {
      title: "Run scheduled job immediately",
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", const: "run_now" },
        jobId: { type: "string", description: "Scheduled job id." },
      },
      required: ["action", "jobId"],
    },
  ],
} as const;

function getScheduledJobCollection(
  context?: ToolExecutionContext,
): ScheduledJobCollection {
  const collection =
    (context?.collections as Record<string, unknown> | undefined)
      ?.scheduled_job;
  if (!collection || typeof collection !== "object") {
    throw new Error("scheduled_job collection is not available");
  }
  return collection as ScheduledJobCollection;
}

function requireNamespace(context?: ToolExecutionContext): string {
  if (context?.namespace) return context.namespace;
  throw new Error("Tenant namespace is required to manage scheduled jobs");
}

function requireJobId(params: ScheduledJobsParams): string {
  if (typeof params.jobId === "string" && params.jobId.trim().length > 0) {
    return params.jobId.trim();
  }
  throw new Error("jobId is required for this scheduled_jobs action");
}

function normalizeSchedule(
  schedule: ScheduledJobSchedule | undefined,
): ScheduledJobSchedule {
  if (!schedule?.expression) {
    throw new Error("schedule.expression is required");
  }
  return {
    type: "cron",
    expression: schedule.expression,
    timezone: schedule.timezone ?? "UTC",
  };
}

function prepareRunMessage(
  message: MessagePayload,
  context: ToolExecutionContext,
  jobId: string,
  jobName: string,
): MessagePayload {
  const rawThread = message.thread && typeof message.thread === "object" &&
      !Array.isArray(message.thread)
    ? message.thread as Record<string, unknown>
    : null;
  const hasThreadRef = typeof rawThread?.id === "string" ||
    typeof rawThread?.externalId === "string";
  const thread = rawThread || context.threadId
    ? {
      ...(rawThread ?? {}),
      ...(!hasThreadRef && context.threadId ? { id: context.threadId } : {}),
    }
    : undefined;

  return {
    ...message,
    sender: {
      ...(message.sender ?? {}),
      type: "job",
      id: message.sender?.id ?? jobId,
      externalId: message.sender?.externalId ?? jobId,
      name: message.sender?.name ?? jobName,
    },
    ...(thread ? { thread } : {}),
  } as MessagePayload;
}

function kindFromMime(mime: string): CreatedAsset["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

async function persistAssetNode(
  context: ToolExecutionContext,
  asset: CreatedAsset,
): Promise<void> {
  const ops = context.db?.ops;
  const namespace = requireNamespace(context);
  if (!ops) return;
  const existing = await ops.unsafeGraph.getNodeById(asset.assetId);
  if (!existing) {
    if (context.threadId) {
      await ops.mutate.assets.create({
        id: asset.assetId,
        threadId: context.threadId,
        ref: asset.ref,
        mime: asset.mime,
        by: "job",
        namespace,
        metadata: {
          kind: asset.kind,
          size: asset.size,
        },
      });
    } else {
      await ops.unsafeGraph.createNode({
        id: asset.assetId,
        namespace,
        type: "asset",
        name: asset.assetId,
        content: null,
        data: {
          assetId: asset.assetId,
          ref: asset.ref,
          mime: asset.mime,
          kind: asset.kind,
          size: asset.size,
          by: "job",
        },
        sourceType: "asset_store",
        sourceId: asset.assetId,
      });
    }
  }
}

async function saveInlineAsset(
  context: ToolExecutionContext,
  bytes: Uint8Array,
  mime: string,
): Promise<CreatedAsset> {
  if (!context.assetStore) {
    throw new Error(
      "Asset store is required to save inline scheduled job assets",
    );
  }
  const { assetId } = await context.assetStore.save(bytes, mime);
  const ref = buildAssetRefForStore(context.assetStore, assetId);
  const asset = {
    assetId,
    ref,
    mime,
    kind: kindFromMime(mime),
    size: bytes.byteLength,
  };
  await persistAssetNode(context, asset);
  return asset;
}

async function normalizeRunMessageAssets(
  message: MessagePayload,
  context: ToolExecutionContext,
): Promise<{ message: MessagePayload; assets: CreatedAsset[] }> {
  if (!Array.isArray(message.content)) return { message, assets: [] };

  const assets: CreatedAsset[] = [];
  const content: MessagePayload["content"] = [];
  for (const part of message.content) {
    if (!isRecord(part)) {
      content.push(part);
      continue;
    }
    const type = part.type;
    if (type !== "image" && type !== "audio" && type !== "file") {
      content.push(part as MessageContentPart);
      continue;
    }

    const mimeType = typeof part.mimeType === "string"
      ? part.mimeType
      : undefined;
    if (typeof part.dataBase64 === "string" && mimeType) {
      const asset = await saveInlineAsset(
        context,
        base64ToBytes(part.dataBase64),
        mimeType,
      );
      assets.push(asset);
      const { dataBase64: _dataBase64, ...rest } = part;
      content.push({
        ...rest,
        url: asset.ref,
        mimeType: asset.mime,
      } as MessageContentPart);
      continue;
    }
    if (typeof part.url === "string" && isDataUrl(part.url)) {
      const parsed = parseDataUrl(part.url);
      if (parsed) {
        const asset = await saveInlineAsset(context, parsed.bytes, parsed.mime);
        assets.push(asset);
        content.push({
          ...part,
          url: asset.ref,
          mimeType: parsed.mime,
        } as MessageContentPart);
        continue;
      }
    }
    content.push(part as MessageContentPart);
  }

  return {
    message: {
      ...message,
      content,
    },
    assets,
  };
}

async function linkJobAssets(
  context: ToolExecutionContext,
  jobId: string,
  assets: CreatedAsset[],
): Promise<void> {
  const ops = context.db?.ops;
  if (!ops || assets.length === 0) return;
  for (const asset of assets) {
    const existingEdges = await ops.unsafeGraph.getEdgesForNode(
      jobId,
      "out",
      [GRAPH_EDGE.HAS_ASSET],
    ).catch(() => []);
    if (
      existingEdges.some((edge) => edge.targetNodeId === asset.assetId)
    ) continue;
    const edge = {
      sourceNodeId: jobId,
      targetNodeId: asset.assetId,
      type: GRAPH_EDGE.HAS_ASSET,
    };
    if (context.threadId) {
      await ops.mutate.graph.createEdge(edge, {
        threadId: context.threadId,
        namespace: context.namespace ?? null,
      }).catch(() => undefined);
    } else {
      await ops.unsafeGraph.createEdge(edge).catch(() => undefined);
    }
  }
}

async function createJob(
  params: ScheduledJobsParams,
  context: ToolExecutionContext,
) {
  const collection = getScheduledJobCollection(context);
  if (!params.name) {
    throw new Error("name is required to create a scheduled job");
  }
  if (!params.run?.message) {
    throw new Error("run.message is required to create a scheduled job");
  }

  const jobId = params.jobId ?? ulid();
  const schedule = normalizeSchedule(params.schedule);
  const next = getNextScheduledRunAt(schedule);
  const preparedMessage = prepareRunMessage(
    params.run.message,
    context,
    jobId,
    params.name,
  );
  const normalizedRun = await normalizeRunMessageAssets(
    preparedMessage,
    context,
  );
  const job = await collection.create({
    id: jobId,
    name: params.name,
    status: params.status ?? "active",
    schedule,
    run: {
      message: normalizedRun.message,
      options: params.run.options ?? null,
    },
    nextRunAt: next.toISOString(),
    nextRunAtMs: next.getTime(),
    lastRunAt: null,
    lastRunAtMs: null,
    metadata: params.metadata ?? null,
  });
  await linkJobAssets(context, job.id, normalizedRun.assets);
  return {
    job,
    assets: normalizedRun.assets.map((asset) => ({
      assetId: asset.assetId,
      ref: asset.ref,
      mime: asset.mime,
      kind: asset.kind,
      size: asset.size,
    })),
  };
}

async function runJobNow(
  params: ScheduledJobsParams,
  context: ToolExecutionContext,
) {
  const collection = getScheduledJobCollection(context);
  const jobId = requireJobId(params);
  const job = await collection.findById(jobId);
  if (!job) throw new Error(`Scheduled job not found: ${jobId}`);
  if (job.status === "cancelled") {
    throw new Error(`Scheduled job is cancelled: ${jobId}`);
  }
  const db = context.db ?? context.dbInstance;
  if (!db) {
    throw new Error("Database instance is required to run a scheduled job");
  }

  const now = new Date();
  const runId = `${job.id}:manual:${now.getTime()}`;
  const templateMetadata = isRecord(job.run.message.metadata)
    ? job.run.message.metadata
    : {};
  const scheduledJob = {
    jobId: job.id,
    jobName: job.name,
    runId,
    manual: true,
    scheduledFor: now.toISOString(),
    scheduledForMs: now.getTime(),
  };
  const message: MessagePayload = {
    ...job.run.message,
    sender: {
      ...(job.run.message.sender ?? {}),
      type: "job",
      id: job.run.message.sender?.id ?? job.id,
      externalId: job.run.message.sender?.externalId ?? job.id,
      name: job.run.message.sender?.name ?? job.name,
    },
    metadata: {
      ...templateMetadata,
      scheduledJob,
    },
  };

  const handle = await runThread(
    db,
    context,
    message,
    {
      ...(job.run.options ?? {}),
      namespace: context.namespace,
      traceId: runId,
      eventMetadata: { scheduledJob },
    },
  );
  await collection.update({ id: job.id }, {
    lastRunAt: now.toISOString(),
    lastRunAtMs: now.getTime(),
  });
  return {
    jobId: job.id,
    runId,
    queueId: handle.queueId,
    threadId: handle.threadId,
    status: handle.status,
  };
}

export default {
  key: "scheduled_jobs",
  name: "Scheduled Jobs",
  description:
    "Manage recurring scheduled Copilotz jobs. Use create to persist a cron schedule and run template; use list/update/pause/resume/cancel/run_now for lifecycle management.",
  inputSchema,
  execute: async (
    params: ScheduledJobsParams,
    context?: ToolExecutionContext,
  ) => {
    if (!context) throw new Error("Tool context is required");
    requireNamespace(context);
    const collection = getScheduledJobCollection(context);

    switch (params.action) {
      case "create":
        return await createJob(params, context);
      case "list": {
        const filter: Record<string, unknown> = {};
        if (params.status) filter.status = params.status;
        const jobs = await collection.find(filter, {
          sort: [["nextRunAtMs", "asc"]],
          limit: 50,
        });
        const filtered = params.threadId
          ? jobs.filter((job) => job.run.message.thread?.id === params.threadId)
          : jobs;
        return { jobs: filtered };
      }
      case "update": {
        const jobId = requireJobId(params);
        const update: Record<string, unknown> = {};
        if (params.name) update.name = params.name;
        if (params.status) update.status = params.status;
        if (params.metadata !== undefined) update.metadata = params.metadata;
        if (params.schedule) {
          const schedule = normalizeSchedule(params.schedule);
          const next = getNextScheduledRunAt(schedule);
          update.schedule = schedule;
          update.nextRunAt = next.toISOString();
          update.nextRunAtMs = next.getTime();
        }
        if (params.run) {
          const existing = await collection.findById(jobId);
          const preparedMessage = prepareRunMessage(
            params.run.message,
            context,
            jobId,
            params.name ?? existing?.name ?? "Scheduled Job",
          );
          const normalized = await normalizeRunMessageAssets(
            preparedMessage,
            context,
          );
          update.run = {
            message: normalized.message,
            options: params.run.options ?? null,
          };
          await linkJobAssets(context, jobId, normalized.assets);
        }
        await collection.update({ id: jobId }, update);
        return { jobId, updated: update };
      }
      case "pause": {
        const jobId = requireJobId(params);
        await collection.update({ id: jobId }, { status: "paused" });
        return { jobId, status: "paused" };
      }
      case "resume": {
        const jobId = requireJobId(params);
        const job = await collection.findById(jobId);
        if (!job) throw new Error(`Scheduled job not found: ${jobId}`);
        const next = getNextScheduledRunAt(job.schedule);
        await collection.update({ id: jobId }, {
          status: "active",
          nextRunAt: next.toISOString(),
          nextRunAtMs: next.getTime(),
          leaseOwner: null,
          leaseUntilMs: null,
        });
        return { jobId, status: "active", nextRunAt: next.toISOString() };
      }
      case "cancel": {
        const jobId = requireJobId(params);
        await collection.update({ id: jobId }, { status: "cancelled" });
        return { jobId, status: "cancelled" };
      }
      case "run_now":
        return await runJobNow(params, context);
      default:
        throw new Error(`Unsupported scheduled_jobs action: ${params.action}`);
    }
  },
};
