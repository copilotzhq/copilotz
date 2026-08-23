import {
  type ActionContext,
  defineAction,
  type RuntimeContextNamespaces,
} from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { type CopilotzPlugin, definePlugin } from "@copilotz/copilotz/plugins";
import type { AgentResource } from "@copilotz/copilotz/core";
import {
  allCollectionRecords,
  allMessages,
  allParticipants,
  allThreads,
  finite,
  inDateRange,
  messagePreview,
  optionalDate,
  pageInfo,
  queryLimit,
  queryText,
  queryTexts,
  record,
} from "./projections.ts";
import type {
  AdminActivityPoint,
  AdminRequest,
  AdminResponse,
  AdminUsageTotals,
  CreateAdminPluginOptions,
} from "./types.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/admin";
const DEFAULT_PLUGIN_VERSION = "3.0.0";
const ACTION_ID_PREFIX = "copilotz.admin";

type AdminActionContext = ActionContext<
  & RuntimeContextNamespaces
  & Readonly<{
    agents: Readonly<Record<string, AgentResource | undefined>>;
  }>
>;

function asRequest(input: unknown): AdminRequest {
  if (
    input &&
    typeof input === "object" &&
    "method" in input &&
    typeof (input as { method?: unknown }).method === "string"
  ) {
    return input as AdminRequest;
  }
  throw new TypeError("Admin actions expect an AdminRequest.");
}

function readOnly(request: AdminRequest): AdminResponse | undefined {
  return request.method === "GET" ? undefined : {
    status: 405,
    data: {
      code: "method_not_allowed",
      message: "Admin projections are read-only.",
    },
  };
}

function usageTotals(records: readonly CollectionRecord[]): AdminUsageTotals {
  return Object.freeze(records.reduce((totals, value) => ({
    totalCalls: totals.totalCalls + 1,
    inputTokens: totals.inputTokens + finite(value.inputTokens),
    outputTokens: totals.outputTokens + finite(value.outputTokens),
    reasoningTokens: totals.reasoningTokens + finite(value.reasoningTokens),
    totalTokens: totals.totalTokens + finite(value.totalTokens),
    totalCostUsd: totals.totalCostUsd + finite(value.totalCostUsd),
  }), {
    totalCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  }));
}

function range(request: AdminRequest) {
  return {
    from: optionalDate(queryText(request, "from")),
    to: optionalDate(queryText(request, "to")),
  };
}

function createdInRange(
  value: CollectionRecord,
  dates: ReturnType<typeof range>,
): boolean {
  const occurredAt = typeof value.occurredAt === "string"
    ? value.occurredAt
    : value.createdAt;
  return inDateRange(occurredAt, dates.from, dates.to);
}

type AdminAction = (
  input: unknown,
  context: AdminActionContext,
) => AdminResponse | Promise<AdminResponse>;

const overview: AdminAction = async (input, context) => {
  const request = asRequest(input);
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const dates = range(request);
  const [threads, messages, participants, usage] = await Promise.all([
    allThreads(context),
    allCollectionRecords(context, "message"),
    allParticipants(context),
    allCollectionRecords(context, "usage"),
  ]);
  const messageTotal =
    messages.filter((message) =>
      inDateRange(message.createdAt, dates.from, dates.to)
    ).length;
  const rangedUsage = usage.filter((value) => createdInRange(value, dates));
  const llm = rangedUsage.filter((value) => value.kind === "llm");
  const tools = rangedUsage.filter((value) => value.kind === "tool");
  const threadStatus = (status: string) =>
    threads.filter((thread) => thread.status === status).length;
  const participantType = (type: string) =>
    participants.filter((participant) => participant.participantType === type)
      .length;
  return {
    status: 200,
    data: {
      threadTotals: {
        total: threads.length,
        active: threadStatus("active"),
        archived: threadStatus("archived"),
        closed: threadStatus("closed"),
      },
      messageTotals: { total: messageTotal },
      participantTotals: {
        total: participants.length,
        human: participantType("human"),
        agent: participantType("agent"),
        tool: participantType("tool"),
        job: participantType("job"),
      },
      llmTotals: usageTotals(llm),
      toolTotals: usageTotals(tools),
    },
  };
};

type ActivityInterval = "hour" | "day" | "week" | "month";

function interval(request: AdminRequest): ActivityInterval {
  const value = queryText(request, "interval") ?? "day";
  if (
    value === "hour" || value === "day" || value === "week" || value === "month"
  ) {
    return value;
  }
  throw new TypeError("interval must be hour, day, week, or month.");
}

function bucket(value: string, unit: ActivityInterval): string {
  const date = new Date(value);
  if (unit === "month") {
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
  } else if (unit === "week") {
    const day = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() - day + 1);
    date.setUTCHours(0, 0, 0, 0);
  } else if (unit === "day") {
    date.setUTCHours(0, 0, 0, 0);
  } else {
    date.setUTCMinutes(0, 0, 0);
  }
  return date.toISOString();
}

type MutableActivityPoint = {
  -readonly [Key in keyof AdminActivityPoint]: AdminActivityPoint[Key];
};

function emptyActivity(bucketValue: string): MutableActivityPoint {
  return {
    bucket: bucketValue,
    messageCount: 0,
    toolCallCount: 0,
    totalCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
}

const activity: AdminAction = async (input, context) => {
  const request = asRequest(input);
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const unit = interval(request);
  const dates = range(request);
  const [messages, usage] = await Promise.all([
    allCollectionRecords(context, "message"),
    allCollectionRecords(context, "usage"),
  ]);
  const points = new Map<string, MutableActivityPoint>();
  const point = (createdAt: string) => {
    const key = bucket(createdAt, unit);
    const existing = points.get(key) ?? emptyActivity(key);
    points.set(key, existing);
    return existing;
  };
  for (const message of messages) {
    if (!inDateRange(message.createdAt, dates.from, dates.to)) continue;
    point(message.createdAt).messageCount += 1;
  }
  for (const value of usage) {
    if (!createdInRange(value, dates)) continue;
    if (value.kind !== "tool" && value.kind !== "llm") continue;
    const occurredAt = typeof value.occurredAt === "string"
      ? value.occurredAt
      : value.createdAt;
    const current = point(occurredAt);
    if (value.kind === "tool") {
      current.toolCallCount += 1;
      continue;
    }
    current.totalCalls += 1;
    current.inputTokens += finite(value.inputTokens);
    current.outputTokens += finite(value.outputTokens);
    current.reasoningTokens += finite(value.reasoningTokens);
    current.totalTokens += finite(value.totalTokens);
    current.totalCostUsd += finite(value.totalCostUsd);
  }
  return {
    status: 200,
    data: [...points.values()].sort((left, right) =>
      left.bucket.localeCompare(right.bucket)
    ),
  };
};

function metadataText(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

const threads: AdminAction = async (input, context) => {
  const request = asRequest(input);
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  const order = queryText(request, "order") ?? "desc";
  if (order !== "asc" && order !== "desc") {
    throw new TypeError("order must be asc or desc.");
  }
  const statuses = queryTexts(request, "status")?.filter((value) =>
    value !== "all"
  );
  const search = queryText(request, "search")?.toLowerCase();
  let values = [
    ...await allThreads(context, {
      participantId: queryText(request, "participantId"),
      status: statuses?.length ? statuses : undefined,
      order,
    }),
  ];
  const after = queryText(request, "after");
  if (after) {
    const index = values.findIndex((value) => value.id === after);
    if (index < 0) throw new Error(`Thread cursor '${after}' was not found.`);
    values = values.slice(index + 1);
  }
  if (search) {
    values = values.filter((thread) =>
      JSON.stringify({
        id: thread.id,
        externalId: thread.externalId,
        metadata: thread.metadata,
      })
        .toLowerCase().includes(search)
    );
  }
  const selected = values.slice(0, limit);
  const data = [];
  for (const thread of selected) {
    const messages = await allMessages(context, thread.id);
    data.push({
      id: thread.id,
      threadId: thread.id,
      externalId: thread.externalId ?? null,
      name: metadataText(record(thread.metadata), "name") ??
        thread.externalId ?? thread.id,
      summary: metadataText(record(thread.metadata), "summary") ?? null,
      status: thread.status,
      participantIds: Array.isArray(thread.participantIds)
        ? thread.participantIds
        : [],
      messageCount: messages.length,
      lastActivityAt: thread.lastEventAt ?? thread.updatedAt,
      lastMessagePreview: await messagePreview(context, messages.at(-1)),
      metadata: thread.metadata,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }
  return { status: 200, data, pageInfo: pageInfo(selected, limit) };
};

const participants: AdminAction = async (input, context) => {
  const request = asRequest(input);
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  const type = queryText(request, "type") ??
    queryText(request, "participantType");
  const search = queryText(request, "search")?.toLowerCase();
  let values = [
    ...await allParticipants(context),
  ];
  if (type && type !== "all") {
    values = values.filter((participant) =>
      participant.participantType === type
    );
  }
  const after = queryText(request, "after");
  if (after) {
    const index = values.findIndex((value) => value.id === after);
    if (index < 0) {
      throw new Error(`Participant cursor '${after}' was not found.`);
    }
    values = values.slice(index + 1);
  }
  if (search) {
    values = values.filter((participant) =>
      JSON.stringify(participant).toLowerCase().includes(search)
    );
  }
  const selected = values.slice(0, limit);
  const data = [];
  for (const participant of selected) {
    const participantThreads = await allThreads(context, {
      participantId: participant.id,
    });
    let messageCount = 0;
    let lastActivityAt: string | null = null;
    for (const thread of participantThreads) {
      const messages = await allMessages(context, thread.id);
      messageCount += messages.filter((message) =>
        message.senderId === participant.id
      ).length;
      const candidate = String(thread.lastEventAt ?? thread.updatedAt);
      if (!lastActivityAt || candidate > lastActivityAt) {
        lastActivityAt = candidate;
      }
    }
    data.push({
      id: participant.id,
      externalId: participant.externalId,
      displayName: participant.name ?? participant.externalId,
      participantType: participant.participantType,
      namespace: participant.namespace,
      messageCount,
      threadCount: participantThreads.length,
      lastActivityAt,
      metadata: participant.metadata,
      createdAt: participant.createdAt,
      updatedAt: participant.updatedAt,
    });
  }
  return { status: 200, data, pageInfo: pageInfo(selected, limit) };
};

function exactUsageWhere(
  request: AdminRequest,
): Record<string, unknown> | undefined {
  const keys = [
    "kind",
    "provider",
    "model",
    "agentId",
    "threadId",
    "initiatedById",
    "status",
  ];
  const where: Record<string, unknown> = {};
  for (const key of keys) {
    const value = queryText(request, key);
    if (value && value !== "all") where[key] = value;
  }
  return Object.keys(where).length ? where : undefined;
}

const usage: AdminAction = async (input, context) => {
  const request = asRequest(input);
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  let values = [
    ...await allCollectionRecords(
      context,
      "usage",
      exactUsageWhere(request),
    ),
  ];
  const dates = range(request);
  values = values.filter((value) => createdInRange(value, dates));
  const after = queryText(request, "after");
  if (after) {
    const index = values.findIndex((value) => value.id === after);
    if (index < 0) throw new Error(`Usage cursor '${after}' was not found.`);
    values = values.slice(index + 1);
  }
  const selected = values.slice(0, limit);
  return {
    status: 200,
    data: selected,
    pageInfo: pageInfo(selected, limit),
  };
};

function publicAgent(agent: AgentResource): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    capabilities: structuredClone(agent.capabilities ?? {}),
  };
}

const agents: AdminAction = (input, context) => {
  const request = asRequest(input);
  const rejected = readOnly(request);
  if (rejected) return rejected;
  return {
    status: 200,
    data: Object.values(context.resources.agents).filter((
      agent,
    ): agent is AgentResource => Boolean(agent)).map(publicAgent),
  };
};

const adminRequestSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    resource: { type: "string" },
    method: { type: "string" },
    path: { type: "array", items: { type: "string" } },
    query: { type: "object" },
    body: {},
    headers: { type: "object" },
    context: { type: "object" },
  },
  required: ["resource", "method"],
} as const;

function queryAction(id: string, execute: AdminAction) {
  return defineAction<
    AdminRequest,
    AdminResponse,
    AdminActionContext,
    typeof adminRequestSchema
  >({
    id,
    inputSchema: adminRequestSchema,
    execute(input, context: AdminActionContext) {
      return execute(input, context);
    },
  });
}

function adminActions() {
  return Object.freeze({
    adminOverview: queryAction(`${ACTION_ID_PREFIX}.overview`, overview),
    adminActivity: queryAction(`${ACTION_ID_PREFIX}.activity`, activity),
    adminThreads: queryAction(`${ACTION_ID_PREFIX}.threads`, threads),
    adminParticipants: queryAction(
      `${ACTION_ID_PREFIX}.participants`,
      participants,
    ),
    adminUsage: queryAction(`${ACTION_ID_PREFIX}.usage`, usage),
    adminAgents: queryAction(`${ACTION_ID_PREFIX}.agents`, agents),
  });
}

/** Creates the queue-free admin projection plugin over typed application APIs. */
export function createAdminPlugin(
  options: CreateAdminPluginOptions = {},
): CopilotzPlugin {
  return definePlugin({
    id: options.id?.trim() || DEFAULT_PLUGIN_ID,
    version: options.version?.trim() || DEFAULT_PLUGIN_VERSION,
    actions: adminActions(),
  });
}
