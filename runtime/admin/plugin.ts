import type { Agent } from "../resources/index.ts";
import type { CollectionRecord } from "../domain/index.ts";
import type {
  FeatureAction,
  FeatureRequest,
  FeatureResource,
  FeatureResponse,
} from "../features/index.ts";
import { type CopilotzPlugin, definePlugin } from "../plugins/index.ts";
import {
  allCollectionRecords,
  allEvents,
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
  AdminUsageTotals,
  CreateAdminPluginOptions,
} from "./types.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/admin";
const DEFAULT_PLUGIN_VERSION = "3.0.0";
const DEFAULT_FEATURE_ID = "admin";

function readOnly(request: FeatureRequest): FeatureResponse | undefined {
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

function range(request: FeatureRequest) {
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

const overview: FeatureAction = async (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const dates = range(request);
  const [threads, participants, usage] = await Promise.all([
    allThreads(context.application, context.namespace),
    allParticipants(context.application, context.namespace),
    allCollectionRecords(context.application, context.namespace, "usage"),
  ]);
  let messageTotal = 0;
  for (const thread of threads) {
    const messages = await allMessages(
      context.application,
      context.namespace,
      thread.id,
    );
    messageTotal += messages.filter((message) =>
      inDateRange(message.createdAt, dates.from, dates.to)
    ).length;
  }
  const rangedUsage = usage.filter((value) => createdInRange(value, dates));
  const llm = rangedUsage.filter((value) => value.kind === "llm");
  const tools = rangedUsage.filter((value) => value.kind === "tool");
  const deliveryStatuses = [
    "pending",
    "leased",
    "retry_wait",
    "succeeded",
    "cancelled",
    "dead_letter",
  ] as const;
  const deliveryCounts = await Promise.all(
    deliveryStatuses.map(async (status) =>
      (await context.application.deliveries.list({
        namespace: context.namespace,
        status,
        limit: 1_000,
      })).length
    ),
  );
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
      deliveryTotals: Object.fromEntries(
        deliveryStatuses.map((
          status,
          index,
        ) => [status, deliveryCounts[index]]),
      ),
    },
  };
};

type ActivityInterval = "hour" | "day" | "week" | "month";

function interval(request: FeatureRequest): ActivityInterval {
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

const activity: FeatureAction = async (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const unit = interval(request);
  const dates = range(request);
  const [events, usage] = await Promise.all([
    allEvents(context.application, context.namespace),
    allCollectionRecords(context.application, context.namespace, "usage"),
  ]);
  const points = new Map<string, MutableActivityPoint>();
  const point = (createdAt: string) => {
    const key = bucket(createdAt, unit);
    const existing = points.get(key) ?? emptyActivity(key);
    points.set(key, existing);
    return existing;
  };
  for (const event of events) {
    if (!inDateRange(event.createdAt, dates.from, dates.to)) continue;
    const current = point(event.createdAt);
    if (event.type === "message.created") current.messageCount += 1;
    if (event.type === "tool_execution.created") current.toolCallCount += 1;
  }
  for (const value of usage) {
    if (value.kind !== "llm" || !createdInRange(value, dates)) continue;
    const occurredAt = typeof value.occurredAt === "string"
      ? value.occurredAt
      : value.createdAt;
    const current = point(occurredAt);
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

const events: FeatureAction = async (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  const dates = range(request);
  const types = queryTexts(request, "type") ?? queryTexts(request, "eventType");
  const search = queryText(request, "search")?.toLowerCase();
  const values = (await allEvents(context.application, context.namespace, {
    threadId: queryText(request, "threadId"),
    correlationId: queryText(request, "correlationId"),
    afterPosition: queryText(request, "afterPosition"),
  })).filter((event) =>
    (!types || types.includes(event.type)) &&
    inDateRange(event.createdAt, dates.from, dates.to) &&
    (!search || JSON.stringify(event).toLowerCase().includes(search))
  ).slice(0, limit);
  return {
    status: 200,
    data: values,
    pageInfo: values.length === limit
      ? { next: values.at(-1)?.position, hasMore: true }
      : { hasMore: false },
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

const threads: FeatureAction = async (request, context) => {
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
    ...await allThreads(context.application, context.namespace, {
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
    const messages = await allMessages(
      context.application,
      context.namespace,
      thread.id,
    );
    data.push({
      id: thread.id,
      threadId: thread.id,
      externalId: thread.externalId ?? null,
      name: metadataText(record(thread.metadata), "name") ??
        thread.externalId ?? thread.id,
      summary: metadataText(record(thread.metadata), "summary") ?? null,
      status: thread.status,
      participantIds: thread.participants.map((participant) => participant.id),
      messageCount: messages.length,
      lastActivityAt: thread.lastEventAt ?? thread.updatedAt,
      lastMessagePreview: await messagePreview(
        context.application,
        context.namespace,
        messages.at(-1),
      ),
      metadata: thread.metadata,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }
  return { status: 200, data, pageInfo: pageInfo(selected, limit) };
};

const participants: FeatureAction = async (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  const type = queryText(request, "type") ??
    queryText(request, "participantType");
  const search = queryText(request, "search")?.toLowerCase();
  let values = [
    ...await allParticipants(context.application, context.namespace),
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
    const participantThreads = await allThreads(
      context.application,
      context.namespace,
      { participantId: participant.id },
    );
    let messageCount = 0;
    let lastActivityAt: string | null = null;
    for (const thread of participantThreads) {
      const messages = await allMessages(
        context.application,
        context.namespace,
        thread.id,
      );
      messageCount += messages.filter((message) =>
        message.sender.id === participant.id
      ).length;
      const candidate = thread.lastEventAt ?? thread.updatedAt;
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
  request: FeatureRequest,
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

const usage: FeatureAction = async (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  let values = [
    ...await allCollectionRecords(
      context.application,
      context.namespace,
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

function hashUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function brainNode(value: CollectionRecord) {
  const layer = typeof value.layer === "string" ? value.layer : "knowledge";
  const kind = typeof value.kind === "string" ? value.kind : "unknown";
  return {
    ...value,
    clusterId: `${layer}:${kind}`,
    x: hashUnit(value.id, 1),
    y: hashUnit(value.id, 2),
  };
}

const brain: FeatureAction = async (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  const limit = queryLimit(request);
  const where: Record<string, unknown> = {};
  for (
    const key of [
      "memorySpaceId",
      "checkpointId",
      "createdByAgentId",
      "originThreadId",
      "layer",
      "kind",
      "status",
    ]
  ) {
    const queryKey = key === "createdByAgentId"
      ? "agentId"
      : key === "originThreadId"
      ? "threadId"
      : key;
    const value = queryText(request, queryKey);
    if (value && value !== "all") where[key] = value;
  }
  let values = [
    ...await allCollectionRecords(
      context.application,
      context.namespace,
      "brain_node",
      Object.keys(where).length ? where : undefined,
    ),
  ];
  const search = queryText(request, "search")?.toLowerCase();
  if (search) {
    values = values.filter((value) =>
      `${String(value.name ?? "")}\n${String(value.content ?? "")}`
        .toLowerCase().includes(search)
    );
  }
  const after = queryText(request, "after");
  if (after) {
    const index = values.findIndex((value) => value.id === after);
    if (index < 0) throw new Error(`Brain cursor '${after}' was not found.`);
    values = values.slice(index + 1);
  }
  const selected = values.slice(0, limit);
  const relations = new Map<string, unknown>();
  for (const value of selected) {
    for (
      const relation of await context.application.relations.list({
        namespace: context.namespace,
        nodeId: value.id,
        direction: "both",
        limit: 1_000,
      })
    ) relations.set(relation.id, relation);
  }
  const stats = Object.values(
    values.reduce<
      Record<
        string,
        { layer: string; kind: string; status: string; count: number }
      >
    >(
      (result, value) => {
        const layer = String(value.layer ?? "knowledge");
        const kind = String(value.kind ?? "unknown");
        const status = String(value.status ?? "active");
        const key = `${layer}\0${kind}\0${status}`;
        const current = result[key] ?? { layer, kind, status, count: 0 };
        current.count += 1;
        result[key] = current;
        return result;
      },
      {},
    ),
  );
  return {
    status: 200,
    data: {
      nodes: selected.map(brainNode),
      edges: [...relations.values()],
      stats,
    },
    pageInfo: pageInfo(selected, limit),
  };
};

function publicAgent(agent: Agent): Record<string, unknown> {
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    runtimes: structuredClone(agent.runtimes ?? {}),
    allowedTools: [...(agent.allowedTools ?? [])],
    allowedAgents: [...(agent.allowedAgents ?? [])],
  };
}

const agents: FeatureAction = (request, context) => {
  const rejected = readOnly(request);
  if (rejected) return rejected;
  return {
    status: 200,
    data: context.application.plugins.list<Agent>("agents").map(publicAgent),
  };
};

function feature(options: CreateAdminPluginOptions): FeatureResource {
  return Object.freeze({
    id: options.featureId?.trim() || DEFAULT_FEATURE_ID,
    actions: Object.freeze({
      overview,
      activity,
      events,
      threads,
      participants,
      usage,
      brain,
      agents,
    }),
  });
}

/** Creates the queue-free admin projection plugin over typed application APIs. */
export function createAdminPlugin(
  options: CreateAdminPluginOptions = {},
): CopilotzPlugin {
  const resource = feature(options);
  return definePlugin({
    manifest: {
      id: options.id?.trim() || DEFAULT_PLUGIN_ID,
      version: options.version?.trim() || DEFAULT_PLUGIN_VERSION,
      provides: { features: [resource.id] },
    },
    resources: { features: [resource] },
  });
}
