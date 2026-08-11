import type { Agent } from "../runtime/resources/index.ts";
import type { CopilotzApplication } from "../runtime/application/index.ts";
import type { AttachmentOutput } from "../runtime/attachments/index.ts";
import type { ContentInput } from "../runtime/content/index.ts";
import type {
  ConversationThread,
  CreateThreadInput,
  Participant,
} from "../runtime/domain/index.ts";
import type {
  DeliveryStatus,
  DurableEvent,
  EventDelivery,
} from "../runtime/events/index.ts";
import {
  type ChannelRuntime,
  createChannelRuntime,
} from "../runtime/channels/index.ts";
import type {
  FeatureContext,
  FeatureRequest,
  FeatureResource,
  FeatureResponse,
} from "../runtime/features/index.ts";

export type EventNativeAppRequest = FeatureRequest;

export type EventNativeAppResponse = FeatureResponse;

export type EventNativeAppError =
  & Error
  & Readonly<{
    status: number;
    code: string;
  }>;

export type EventNativeFeatureContext = FeatureContext;

export type EventNativeFeatureResource = FeatureResource;

export const EVENT_NATIVE_OUTPUT_STREAM = "copilotz.output-stream.v1";

/** Framework-neutral request-bound channel output. */
export type EventNativeOutputStream = Readonly<{
  type: typeof EVENT_NATIVE_OUTPUT_STREAM;
  outputs: ReadableStream<AttachmentOutput>;
  done: Promise<void>;
  cancel(reason?: string): Promise<void>;
}>;

export type CreateEventNativeAppOptions = Readonly<{
  resolveNamespace?: (
    request: EventNativeAppRequest,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /** Trusted authorization boundary for selecting a physical DB schema. */
  resolveDatabaseSchema?: (
    request: EventNativeAppRequest,
  ) => string | null | undefined | Promise<string | null | undefined>;
  channels?: ChannelRuntime;
  /** Supplies an explicitly schema-bound channel runtime when one is injected. */
  resolveChannels?: (
    databaseSchema: string,
    application: CopilotzApplication,
  ) => ChannelRuntime | Promise<ChannelRuntime>;
  onDetachedChannelError?: (error: unknown) => void;
}>;

export type EventNativeApp = Readonly<{
  handle(request: EventNativeAppRequest): Promise<EventNativeAppResponse>;
  resources(): readonly Readonly<
    { name: string; methods: readonly string[] }
  >[];
}>;

export function isEventNativeOutputStream(
  value: unknown,
): value is EventNativeOutputStream {
  const candidate = value as Partial<EventNativeOutputStream> | undefined;
  return Boolean(
    value && typeof value === "object" &&
      candidate?.type === EVENT_NATIVE_OUTPUT_STREAM &&
      typeof (candidate.outputs as { getReader?: unknown } | undefined)
          ?.getReader === "function" &&
      typeof (candidate.done as { then?: unknown } | undefined)?.then ===
        "function" &&
      typeof candidate.cancel === "function",
  );
}

function appError(
  status: number,
  code: string,
  message: string,
): EventNativeAppError {
  return Object.assign(new Error(message), { status, code });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function queryText(
  query: EventNativeAppRequest["query"],
  name: string,
): string | undefined {
  const value = query?.[name];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

function queryTexts(
  query: EventNativeAppRequest["query"],
  name: string,
): readonly string[] | undefined {
  const value = query?.[name];
  if (Array.isArray(value)) {
    const result = value.map((item) => item.trim()).filter(Boolean);
    return result.length ? result : undefined;
  }
  const candidate = queryText(query, name);
  if (!candidate) return undefined;
  const result = candidate.split(",").map((item) => item.trim()).filter(
    Boolean,
  );
  return result.length ? result : undefined;
}

function queryNumber(
  query: EventNativeAppRequest["query"],
  name: string,
): number | undefined {
  const value = queryText(query, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw appError(400, "invalid_query", `${name} must be a positive integer.`);
  }
  return number;
}

function queryChoice<T extends string>(
  query: EventNativeAppRequest["query"],
  name: string,
  choices: readonly T[],
): T | undefined {
  const value = queryText(query, name);
  if (value === undefined) return undefined;
  if (!choices.includes(value as T)) {
    throw appError(
      400,
      "invalid_query",
      `${name} must be one of: ${choices.join(", ")}.`,
    );
  }
  return value as T;
}

function queryObject(
  query: EventNativeAppRequest["query"],
  name: string,
): Record<string, unknown> | undefined {
  const value = queryText(query, name);
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The stable error below deliberately avoids leaking JSON parser detail.
  }
  throw appError(400, "invalid_query", `${name} must be a JSON object.`);
}

function header(
  headers: EventNativeAppRequest["headers"],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return undefined;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function publicAgent(agent: Agent): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: agent.id ?? agent.name,
    name: agent.name,
    role: agent.role ?? null,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.runtimes ? { runtimes: structuredClone(agent.runtimes) } : {}),
    ...(agent.capabilities
      ? { capabilities: structuredClone(agent.capabilities) }
      : {}),
  });
}

function nextPage<T extends { id: string }>(
  values: readonly T[],
  limit: number | undefined,
): EventNativeAppResponse["pageInfo"] {
  return limit !== undefined && values.length === limit
    ? Object.freeze({ next: values.at(-1)?.id, hasMore: true })
    : Object.freeze({ hasMore: false });
}

function featureId(feature: FeatureResource): string {
  if (!feature.id?.trim()) {
    throw new TypeError("Feature resources require an ID.");
  }
  return feature.id.trim();
}

async function requestScope(
  application: CopilotzApplication,
  request: EventNativeAppRequest,
  options: CreateEventNativeAppOptions,
): Promise<Readonly<{ namespace: string; databaseSchema: string }>> {
  const context = request.context?.namespace;
  const resolved = context?.trim() ||
    (await options.resolveNamespace?.(request))?.trim() ||
    application.config.namespace;
  if (!resolved) {
    throw appError(400, "namespace_required", "Tenant namespace is required.");
  }
  const trustedSchema = (await options.resolveDatabaseSchema?.(request))
    ?.trim();
  const requestedSchema = request.context?.databaseSchema?.trim();
  const databaseSchema = trustedSchema || application.config.databaseSchema;
  if (requestedSchema && requestedSchema !== databaseSchema) {
    throw appError(
      400,
      "schema_mismatch",
      "Request database schema does not match its trusted application scope.",
    );
  }
  return Object.freeze({ namespace: resolved, databaseSchema });
}

function applicationForDatabaseScope(
  application: CopilotzApplication,
  scope: Awaited<ReturnType<CopilotzApplication["databaseScope"]>>,
): CopilotzApplication {
  if (scope.databaseSchema === application.config.databaseSchema) {
    return application;
  }
  return Object.freeze({
    ...application,
    ...scope,
    config: Object.freeze({
      ...application.config,
      databaseSchema: scope.databaseSchema,
    }),
    goal(input) {
      return application.goal({
        ...input,
        databaseSchema: input.databaseSchema ?? scope.databaseSchema,
      });
    },
  });
}

function threadResponse(
  namespace: string,
  thread: ConversationThread | null,
): EventNativeAppResponse {
  if (!thread || thread.namespace !== namespace) {
    throw appError(404, "thread_not_found", "Thread was not found.");
  }
  return { status: 200, data: thread };
}

async function messageList(
  application: CopilotzApplication,
  namespace: string,
  threadId: string,
  request: EventNativeAppRequest,
): Promise<EventNativeAppResponse> {
  const thread = await application.conversation.getThread(namespace, threadId);
  if (!thread) {
    throw appError(404, "thread_not_found", "Thread was not found.");
  }
  const limit = queryNumber(request.query, "limit");
  const messages = await application.conversation.listMessages(
    namespace,
    threadId,
    {
      after: queryText(request.query, "after"),
      before: queryText(request.query, "before"),
      limit,
      order: queryChoice(request.query, "order", ["asc", "desc"]),
      view: queryChoice(request.query, "view", ["active", "all"]),
    },
  );
  return {
    status: 200,
    data: messages,
    pageInfo: nextPage(messages, limit),
  };
}

type ThreadActivityDelivery = Readonly<{
  id: string;
  eventId: string;
  eventType: string;
  consumerId: string;
  status: EventDelivery["status"];
  attempts: number;
  priority: number;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
}>;

function activityDelivery(
  event: DurableEvent,
  delivery: EventDelivery,
): ThreadActivityDelivery {
  return Object.freeze({
    id: delivery.id,
    eventId: event.id,
    eventType: event.type,
    consumerId: delivery.consumerId,
    status: delivery.status,
    attempts: delivery.attempts,
    priority: delivery.priority,
    correlationId: event.correlationId,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  });
}

async function threadActivity(
  application: CopilotzApplication,
  namespace: string,
  thread: ConversationThread,
  request: EventNativeAppRequest,
): Promise<EventNativeAppResponse> {
  const limit = queryNumber(request.query, "limit") ?? 1_000;
  const events = await application.events.list({
    namespace,
    threadId: thread.id,
    limit,
  });
  const deliveries = (
    await Promise.all(
      events.map(async (event) =>
        (await application.deliveries.list({
          namespace,
          eventId: event.id,
          limit: 1_000,
        })).map((delivery) => activityDelivery(event, delivery))
      ),
    )
  ).flat();
  const active = deliveries.filter((delivery) =>
    delivery.status === "pending" || delivery.status === "leased" ||
    delivery.status === "retry_wait"
  );
  const failures = deliveries.filter((delivery) =>
    delivery.status === "dead_letter"
  ).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const updatedAt = deliveries.reduce(
    (latest, delivery) =>
      delivery.updatedAt > latest ? delivery.updatedAt : latest,
    thread.updatedAt,
  );
  const includeDeliveries = queryText(request.query, "includeDeliveries") ===
    "true";
  return {
    status: 200,
    data: Object.freeze({
      threadId: thread.id,
      status: active.length ? "running" : failures.length ? "failed" : "idle",
      activeCount: active.length,
      ...(includeDeliveries ? { activeDeliveries: Object.freeze(active) } : {}),
      lastFailure: failures.at(-1) ?? null,
      updatedAt,
    }),
  };
}

async function handleThreads(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (request.method === "GET" && path.length === 0) {
    const limit = queryNumber(request.query, "limit");
    const statuses = queryTexts(request.query, "status");
    const threads = await application.conversation.listThreads(namespace, {
      participantId: queryText(request.query, "participantId"),
      status: statuses,
      after: queryText(request.query, "after"),
      limit,
      order: queryChoice(request.query, "order", ["asc", "desc"]),
    });
    return { status: 200, data: threads, pageInfo: nextPage(threads, limit) };
  }
  if (request.method === "POST" && path.length === 0) {
    const body = record(request.body);
    const created = await application.conversation.createThread({
      ...body,
      namespace,
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    } as CreateThreadInput);
    return { status: created.deduplicated ? 200 : 201, data: created.value };
  }
  if (path.length === 1 && request.method === "GET") {
    return await threadResponse(
      namespace,
      await application.conversation.getThread(namespace, path[0]),
    );
  }
  if (path.length === 1 && request.method === "PATCH") {
    const updated = await application.conversation.updateThread({
      namespace,
      id: path[0],
      patch: record(request.body),
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 200, data: updated.value };
  }
  if (path.length === 1 && request.method === "DELETE") {
    await application.conversation.deleteThread({
      namespace,
      id: path[0],
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 204 };
  }
  if (
    path.length === 2 && path[1] === "activity" && request.method === "GET"
  ) {
    const thread = await application.conversation.getThread(namespace, path[0]);
    if (!thread) {
      throw appError(404, "thread_not_found", "Thread was not found.");
    }
    return await threadActivity(application, namespace, thread, request);
  }
  if (
    path.length === 2 && path[1] === "events" && request.method === "GET"
  ) {
    const thread = await application.conversation.getThread(namespace, path[0]);
    if (!thread) {
      throw appError(404, "thread_not_found", "Thread was not found.");
    }
    const limit = queryNumber(request.query, "limit");
    const events = await application.events.list({
      namespace,
      threadId: thread.id,
      correlationId: queryText(request.query, "correlationId"),
      afterPosition: queryText(request.query, "afterPosition"),
      limit,
    });
    return {
      status: 200,
      data: events,
      pageInfo: limit !== undefined && events.length === limit
        ? Object.freeze({ next: events.at(-1)?.position, hasMore: true })
        : Object.freeze({ hasMore: false }),
    };
  }
  if (path.length === 2 && path[1] === "messages" && request.method === "GET") {
    return await messageList(application, namespace, path[0], request);
  }
  if (
    path.length === 2 && path[1] === "messages" &&
    request.method === "DELETE"
  ) {
    await application.conversation.deleteThreadMessages({
      namespace,
      threadId: path[0],
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 204 };
  }
  if (
    path.length === 4 && path[1] === "messages" && path[3] === "edit" &&
    request.method === "POST"
  ) {
    const body = record(request.body);
    if (body.content === undefined) {
      throw appError(400, "content_required", "Edited content is required.");
    }
    const deduplicationId = header(request.headers, "idempotency-key");
    const content = await application.content.preparer.prepare(
      body.content as ContentInput | readonly ContentInput[],
      {
        namespace,
        ...(deduplicationId
          ? { idempotencyKey: `${deduplicationId}:content` }
          : {}),
      },
    );
    const revised = await application.conversation.reviseMessage({
      namespace,
      threadId: path[0],
      messageId: path[2],
      content,
      ...(body.metadata === undefined
        ? {}
        : { metadata: record(body.metadata) }),
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId,
        metadata: { sourceAdapter: "http" },
      },
    });
    return {
      status: revised.deduplicated ? 200 : 201,
      data: revised.value,
    };
  }
  throw appError(404, "route_not_found", "Thread route was not found.");
}

async function handleParticipants(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (request.method === "GET" && path.length === 0) {
    const limit = queryNumber(request.query, "limit");
    const participants = await application.conversation.listParticipants(
      namespace,
      {
        participantType: queryChoice<Participant["participantType"]>(
          request.query,
          "type",
          ["human", "agent", "tool", "job"],
        ),
        after: queryText(request.query, "after"),
        limit,
      },
    );
    return {
      status: 200,
      data: participants,
      pageInfo: nextPage(participants, limit),
    };
  }
  if (path.length !== 1) {
    throw appError(404, "route_not_found", "Participant route was not found.");
  }
  const participant = await application.conversation.getParticipantByExternalId(
    namespace,
    path[0],
  ) ?? await application.conversation.getParticipant(namespace, path[0]);
  if (request.method === "GET") {
    if (!participant) {
      throw appError(
        404,
        "participant_not_found",
        "Participant was not found.",
      );
    }
    return { status: 200, data: participant };
  }
  if (request.method === "PATCH") {
    if (!participant) {
      throw appError(
        404,
        "participant_not_found",
        "Participant was not found.",
      );
    }
    const updated = await application.conversation.updateParticipant({
      namespace,
      id: participant.id,
      patch: record(request.body),
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 200, data: updated.value };
  }
  throw appError(
    405,
    "method_not_allowed",
    "Participant method is not allowed.",
  );
}

async function handleCollections(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (request.method === "GET" && path.length === 0) {
    return { status: 200, data: application.collections.names };
  }
  const name = path[0];
  if (!name) {
    throw appError(404, "route_not_found", "Collection route was not found.");
  }
  let collection;
  try {
    collection = application.collections.get(name);
  } catch {
    throw appError(
      404,
      "collection_not_found",
      `Collection '${name}' was not found.`,
    );
  }
  if (request.method === "GET" && path.length === 1) {
    const limit = queryNumber(request.query, "limit");
    const values = await collection.list(namespace, {
      after: queryText(request.query, "after"),
      limit,
      where: queryObject(request.query, "where"),
    });
    return { status: 200, data: values, pageInfo: nextPage(values, limit) };
  }
  if (request.method === "POST" && path.length === 1) {
    const created = await collection.create(record(request.body), {
      namespace,
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: created.deduplicated ? 200 : 201, data: created.value };
  }
  const id = path[1];
  if (
    id && request.method === "POST" && path.length === 4 &&
    path[2] === "commands"
  ) {
    const commanded = await collection.command(id, path[3], request.body, {
      namespace,
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 200, data: commanded.value };
  }
  if (!id || path.length !== 2) {
    throw appError(404, "route_not_found", "Collection route was not found.");
  }
  if (request.method === "GET") {
    const value = await collection.get(namespace, id);
    if (!value) {
      throw appError(404, "record_not_found", "Record was not found.");
    }
    return { status: 200, data: value };
  }
  if (request.method === "PATCH" || request.method === "PUT") {
    const updated = await collection.update(id, record(request.body), {
      namespace,
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 200, data: updated.value };
  }
  if (request.method === "DELETE") {
    await collection.delete(id, {
      namespace,
      identity: {
        correlationId: header(request.headers, "x-copilotz-correlation-id"),
        deduplicationId: header(request.headers, "idempotency-key"),
        metadata: { sourceAdapter: "http" },
      },
    });
    return { status: 204 };
  }
  throw appError(
    405,
    "method_not_allowed",
    "Collection method is not allowed.",
  );
}

async function handleAssets(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (request.method !== "GET" || path.length !== 1) {
    throw appError(404, "route_not_found", "Asset route was not found.");
  }
  let body;
  try {
    body = await application.content.assets.read(namespace, path[0]);
  } catch {
    throw appError(404, "asset_not_found", "Asset was not found.");
  }
  const format = queryText(request.query, "format") ?? "metadata";
  if (format === "metadata") return { status: 200, data: body.asset };
  const encoded = base64(body.bytes);
  if (format === "base64") {
    return {
      status: 200,
      data: { asset: body.asset, base64: encoded },
    };
  }
  if (format === "dataUrl") {
    return {
      status: 200,
      data: {
        asset: body.asset,
        dataUrl: `data:${body.asset.mediaType};base64,${encoded}`,
      },
    };
  }
  throw appError(400, "invalid_query", "Unknown asset format.");
}

async function handleEvents(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (request.method !== "GET") {
    throw appError(405, "method_not_allowed", "Events are immutable.");
  }
  if (path.length === 1) {
    const event = await application.events.get(namespace, path[0]);
    if (!event) throw appError(404, "event_not_found", "Event was not found.");
    return { status: 200, data: event };
  }
  const events = await application.events.list({
    namespace,
    threadId: queryText(request.query, "threadId"),
    correlationId: queryText(request.query, "correlationId"),
    afterPosition: queryText(request.query, "afterPosition"),
    limit: queryNumber(request.query, "limit"),
  });
  return { status: 200, data: events };
}

async function handleDeliveries(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (request.method === "GET" && path.length === 0) {
    return {
      status: 200,
      data: await application.deliveries.list({
        namespace,
        eventId: queryText(request.query, "eventId"),
        consumerId: queryText(request.query, "consumerId"),
        status: queryChoice<DeliveryStatus>(request.query, "status", [
          "pending",
          "leased",
          "retry_wait",
          "succeeded",
          "cancelled",
          "dead_letter",
        ]),
        limit: queryNumber(request.query, "limit"),
      }),
    };
  }
  if (request.method === "POST" && path.length === 2) {
    const changed = path[1] === "retry"
      ? await application.deliveries.retry(namespace, path[0])
      : path[1] === "discard"
      ? await application.deliveries.discard(namespace, path[0])
      : false;
    if (!changed) {
      throw appError(409, "delivery_not_changed", "Delivery was not changed.");
    }
    return { status: 200, data: { id: path[0], action: path[1] } };
  }
  throw appError(404, "route_not_found", "Delivery route was not found.");
}

async function handleFeatures(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  if (path.length !== 2) {
    throw appError(404, "route_not_found", "Feature route was not found.");
  }
  const feature = application.plugins.list<FeatureResource>(
    "features",
  ).find((candidate) => featureId(candidate) === path[0]);
  const action = feature?.actions[path[1]];
  if (!feature || !action) {
    throw appError(404, "feature_not_found", "Feature action was not found.");
  }
  const output = await action(request, {
    application,
    namespace,
    databaseSchema: application.config.databaseSchema,
    request,
  });
  const response = record(output);
  return "status" in response && typeof response.status === "number"
    ? response as EventNativeAppResponse
    : { status: 200, data: output };
}

async function handleChannels(
  channels: ChannelRuntime,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  const ingress = path[0];
  const egress = path.length === 1
    ? ingress
    : path.length === 3 && path[1] === "to"
    ? path[2]
    : undefined;
  if (!ingress || !egress) {
    throw appError(404, "route_not_found", "Channel route was not found.");
  }
  if (!channels.get(ingress)?.ingress) {
    throw appError(
      404,
      "channel_not_found",
      `Channel ingress '${ingress}' was not found.`,
    );
  }
  if (!channels.get(egress)?.egress) {
    throw appError(
      404,
      "channel_not_found",
      `Channel egress '${egress}' was not found.`,
    );
  }
  const suppliedCallback = request.context?.callback;
  const requestBound = channels.get(egress)?.egress?.requestBound === true;
  const bridge = !suppliedCallback && requestBound
    ? new TransformStream<AttachmentOutput, AttachmentOutput>()
    : undefined;
  const writer = bridge?.writable.getWriter();
  const callback = suppliedCallback ??
    (writer ? (output: AttachmentOutput) => writer.write(output) : undefined);
  const rawBody = request.context?.rawBody;
  let dispatched;
  try {
    dispatched = await channels.dispatch(namespace, {
      method: request.method,
      headers: request.headers ?? {},
      query: request.query,
      body: request.body,
      ...(rawBody instanceof Uint8Array ? { rawBody } : {}),
      ...(typeof callback === "function"
        ? {
          callback: callback as (
            output: AttachmentOutput,
          ) => void | Promise<void>,
        }
        : {}),
      context: request.context,
      route: { ingress, egress },
    });
  } catch (error) {
    await writer?.abort(error).catch(() => undefined);
    throw error;
  }
  if (bridge && writer) {
    const done = dispatched.done.then(
      () => writer.close(),
      async (error) => {
        await writer.abort(error).catch(() => undefined);
        throw error;
      },
    );
    done.catch(() => undefined);
    const output: EventNativeOutputStream = Object.freeze({
      type: EVENT_NATIVE_OUTPUT_STREAM,
      outputs: bridge.readable,
      done,
      cancel: (reason) => dispatched.cancel(reason),
    });
    return { status: 200, data: output };
  }
  if (dispatched.requestBound) await dispatched.done;
  return {
    status: dispatched.status,
    data: dispatched.response ?? {
      accepted: true,
      executions: dispatched.executions.length,
    },
  };
}

/** Creates the queue-free, graph/event-native framework-neutral HTTP facade. */
export function createEventNativeApp(
  application: CopilotzApplication,
  options: CreateEventNativeAppOptions = {},
): EventNativeApp {
  const channels = options.channels ?? createChannelRuntime(application, {
    onDetachedError: (error) => options.onDetachedChannelError?.(error),
  });
  const applicationScopes = new Map<string, Promise<CopilotzApplication>>();
  const channelScopes = new Map<string, Promise<ChannelRuntime>>();
  const scopedApplication = (databaseSchema: string) => {
    if (databaseSchema === application.config.databaseSchema) {
      return Promise.resolve(application);
    }
    const existing = applicationScopes.get(databaseSchema);
    if (existing) return existing;
    const pending = application.databaseScope(databaseSchema).then((scope) =>
      applicationForDatabaseScope(application, scope)
    ).catch((error) => {
      if (applicationScopes.get(databaseSchema) === pending) {
        applicationScopes.delete(databaseSchema);
      }
      throw error;
    });
    applicationScopes.set(databaseSchema, pending);
    return pending;
  };
  const scopedChannels = (
    databaseSchema: string,
    scoped: CopilotzApplication,
  ): Promise<ChannelRuntime> => {
    if (databaseSchema === application.config.databaseSchema) {
      return Promise.resolve(channels);
    }
    const existing = channelScopes.get(databaseSchema);
    if (existing) return existing;
    const pending = options.resolveChannels
      ? Promise.resolve(options.resolveChannels(databaseSchema, scoped))
      : options.channels
      ? Promise.reject(
        new Error(
          "An injected channel runtime requires resolveChannels for non-default database schemas.",
        ),
      )
      : Promise.resolve(createChannelRuntime(scoped, {
        onDetachedError: (error) => options.onDetachedChannelError?.(error),
      }));
    channelScopes.set(databaseSchema, pending);
    void pending.catch(() => {
      if (channelScopes.get(databaseSchema) === pending) {
        channelScopes.delete(databaseSchema);
      }
    });
    return pending;
  };
  const resources = Object.freeze([
    { name: "agents", methods: Object.freeze(["GET"]) },
    { name: "assets", methods: Object.freeze(["GET"]) },
    {
      name: "channels",
      methods: Object.freeze(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    },
    {
      name: "collections",
      methods: Object.freeze(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    },
    { name: "deliveries", methods: Object.freeze(["GET", "POST"]) },
    { name: "events", methods: Object.freeze(["GET"]) },
    {
      name: "features",
      methods: Object.freeze(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    },
    { name: "participants", methods: Object.freeze(["GET", "PATCH"]) },
    {
      name: "threads",
      methods: Object.freeze(["GET", "POST", "PATCH", "DELETE"]),
    },
  ]);
  return Object.freeze({
    resources: () => resources,
    async handle(request) {
      const requestBoundary = await requestScope(
        application,
        request,
        options,
      );
      const scoped = await scopedApplication(requestBoundary.databaseSchema);
      const namespace = requestBoundary.namespace;
      const path = request.path ?? [];
      switch (request.resource) {
        case "agents":
          if (request.method !== "GET" || path.length !== 0) {
            throw appError(
              404,
              "route_not_found",
              "Agent route was not found.",
            );
          }
          return {
            status: 200,
            data: scoped.plugins.list<Agent>("agents").map(publicAgent),
          };
        case "assets":
          return await handleAssets(scoped, namespace, request, path);
        case "channels":
          return await handleChannels(
            await scopedChannels(requestBoundary.databaseSchema, scoped),
            namespace,
            request,
            path,
          );
        case "threads":
          return await handleThreads(scoped, namespace, request, path);
        case "participants":
          return await handleParticipants(
            scoped,
            namespace,
            request,
            path,
          );
        case "collections":
          return await handleCollections(scoped, namespace, request, path);
        case "events":
          return await handleEvents(scoped, namespace, request, path);
        case "deliveries":
          return await handleDeliveries(scoped, namespace, request, path);
        case "features":
          return await handleFeatures(scoped, namespace, request, path);
        default:
          throw appError(
            404,
            "route_not_found",
            "Application route was not found.",
          );
      }
    },
  });
}
