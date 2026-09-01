import type { AgentResource } from "@copilotz/copilotz/core";
import { channelIngress } from "../plugins/channel-core/authoring/channel-ingress/index.ts";
import { defineChannelResource } from "../plugins/channel-core/authoring/channel-resource/index.ts";
import type {
  ChannelAcceptResult,
  ChannelAdapter,
  ChannelIngressOccurrence,
  ChannelRequest,
} from "../plugins/channel-core/internal/contracts.ts";
import {
  getThread,
  listMessages,
  listThreads,
  projectParticipant,
} from "./collection-projections.ts";
import {
  createEventNativeMessageHistoryIncluded,
  type EventNativeHistoryInclude,
} from "./history.ts";
import { eventNativeAsset } from "./assets.ts";
import type {
  ApplicationOperationAttachment,
  ApplicationOutput,
  ApplicationSendHandle,
  ApplicationSendInput,
  InternalCopilotzApplication as CopilotzApplication,
} from "../runtime/application/types.ts";
import {
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
} from "../runtime/streams/index.ts";
import type { ConversationThread, Participant } from "@copilotz/copilotz/core";
import type { CollectionMutationIdentity } from "../runtime/collections/index.ts";
import type {
  DeliveryStatus,
  DurableEvent,
  EventDelivery,
} from "../runtime/events/index.ts";

export type EventNativeAppRequest = Readonly<{
  resource: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "QUERY";
  path?: readonly string[];
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  context?: Readonly<
    Record<string, unknown> & {
      namespace?: string;
      databaseSchema?: string;
    }
  >;
}>;

export type EventNativeAppResponse = Readonly<{
  status: number;
  headers?: HeadersInit;
  data?: unknown;
  included?: unknown;
  pageInfo?: Readonly<{
    next?: string;
    hasMore: boolean;
    replayCursor?: string;
    activeOperationIds?: readonly string[];
  }>;
}>;

export type EventNativeAppError =
  & Error
  & Readonly<{
    status: number;
    code: string;
  }>;

export const EVENT_NATIVE_OUTPUT_STREAM = "copilotz.output-stream.v1";

/** Framework-neutral request-bound channel output. */
export type EventNativeOutputStream = Readonly<{
  type: typeof EVENT_NATIVE_OUTPUT_STREAM;
  outputs: ReadableStream<ApplicationOutput>;
  done: Promise<void>;
  operationId?: string;
  threadId?: string;
  replayCursor?: string;
  /** Thread feeds track one durable Event position per operation. */
  compositeCursor?: boolean;
  /** Transport interruption detaches; it never durably cancels an operation. */
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

function operationOutput(
  output: ApplicationOutput,
  operationId: string,
  threadId?: string,
): ApplicationOutput {
  return Object.freeze({
    ...output,
    operationId,
    ...(threadId ? { threadId } : {}),
  });
}

/** Internal transport helper; exported for deterministic cursor regressions. */
export function mergeOperationAttachmentReplayCursors(
  attachments: readonly Readonly<{
    operationId: string;
    replayCursor: string;
  }>[],
  replayCursor?: string,
): string {
  const base = decodeOperationReplayCursor(replayCursor);
  const operationEventPositions = { ...base.operationEventPositions };
  const operationStreamPositions = Object.fromEntries(
    Object.entries(base.operationStreamPositions ?? {}).map(([id, state]) => [
      id,
      Object.freeze({
        highWatermark: state.highWatermark,
        offsets: Object.freeze({ ...state.offsets }),
      }),
    ]),
  );
  for (const { replayCursor: normalizedCursor, operationId } of attachments) {
    const normalized = decodeOperationReplayCursor(normalizedCursor);
    const eventPosition = normalized.operationEventPositions?.[operationId] ??
      normalized.eventPosition;
    if (eventPosition) operationEventPositions[operationId] = eventPosition;
    delete operationStreamPositions[operationId];
    const streamPosition = normalized.operationStreamPositions?.[operationId];
    if (streamPosition) operationStreamPositions[operationId] = streamPosition;
  }
  return encodeOperationReplayCursor({
    ...(base.eventPosition ? { eventPosition: base.eventPosition } : {}),
    ...(Object.keys(operationEventPositions).length
      ? { operationEventPositions }
      : {}),
    ...(Object.keys(operationStreamPositions).length
      ? { operationStreamPositions }
      : {}),
  });
}

function mergeOperationAttachments(
  attachments: readonly Readonly<{
    attachment: ApplicationOperationAttachment;
    operationId: string;
    threadId?: string;
  }>[],
  replayCursor?: string,
): EventNativeOutputStream {
  const normalizedReplayCursor = mergeOperationAttachmentReplayCursors(
    attachments.map(({ attachment, operationId }) => ({
      operationId,
      replayCursor: attachment.replayCursor,
    })),
    replayCursor,
  );
  let controller:
    | ReadableStreamDefaultController<ApplicationOutput>
    | undefined;
  let detached = false;
  const outputs = new ReadableStream<ApplicationOutput>({
    start(value) {
      controller = value;
    },
    async cancel(reason) {
      detached = true;
      await Promise.allSettled(
        attachments.map(({ attachment }) => attachment.detach(String(reason))),
      );
    },
  }, { highWaterMark: 256 });
  const done = (async () => {
    try {
      await Promise.all(
        attachments.map(async ({ attachment, operationId, threadId }) => {
          for await (const output of attachment.outputs) {
            if (detached) return;
            controller?.enqueue(operationOutput(output, operationId, threadId));
          }
          await attachment.done;
        }),
      );
      if (!detached) controller?.close();
    } catch (error) {
      if (!detached) controller?.error(error);
      throw error;
    }
  })();
  void done.catch(() => undefined);
  return Object.freeze({
    type: EVENT_NATIVE_OUTPUT_STREAM,
    outputs,
    done,
    ...(attachments.length === 1
      ? { operationId: attachments[0].operationId }
      : {}),
    ...(attachments.length === 1 && attachments[0].threadId
      ? { threadId: attachments[0].threadId }
      : {}),
    replayCursor: normalizedReplayCursor,
    ...(attachments.length > 1 ? { compositeCursor: true } : {}),
    async cancel(reason = "operation_observation_detached") {
      if (detached) return;
      detached = true;
      await Promise.allSettled(
        attachments.map(({ attachment }) => attachment.detach(reason)),
      );
      try {
        controller?.close();
      } catch {
        // The transport may already have cancelled the stream.
      }
    },
  });
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

function mutationIdentity(
  request: EventNativeAppRequest,
): CollectionMutationIdentity {
  return Object.freeze({
    correlationId: header(request.headers, "x-copilotz-correlation-id"),
    deduplicationId: header(request.headers, "idempotency-key"),
    metadata: { sourceAdapter: "http" },
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function publicAgent(agent: AgentResource): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: agent.id ?? agent.name,
    name: agent.name,
    role: agent.role ?? null,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.capabilities
      ? { capabilities: structuredClone(agent.capabilities) }
      : {}),
  });
}

function nextPage<T extends { id: string }>(
  values: readonly T[],
  limit: number | undefined,
): NonNullable<EventNativeAppResponse["pageInfo"]> {
  return limit !== undefined && values.length === limit
    ? Object.freeze({ next: values.at(-1)?.id, hasMore: true })
    : Object.freeze({ hasMore: false });
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
  const collections = application.collections.withScope({ namespace });
  const thread = await getThread(collections, threadId);
  if (!thread) {
    throw appError(404, "thread_not_found", "Thread was not found.");
  }
  const limit = Math.min(queryNumber(request.query, "limit") ?? 100, 1_000);
  const messageQuery = Object.freeze({
    after: queryText(request.query, "after"),
    before: queryText(request.query, "before"),
    // Fetch one extra semantic record so hasMore is exact rather than guessed
    // from a full page that may also be the end of the Thread.
    limit: limit + 1,
    order: queryChoice(request.query, "order", ["asc", "desc"]),
    view: queryChoice(request.query, "view", ["active", "all"]),
  });
  let eventPosition: string | undefined;
  let messages!: Awaited<ReturnType<typeof listMessages>>;
  let activeOperations: Awaited<
    ReturnType<typeof application.operations.listForThread>
  > = [];
  // Establish a history/feed boundary without requiring a transaction across
  // collection and operation projections. If the Thread changes inside the
  // window, retry the canonical snapshot; on the final attempt retain the
  // earlier watermark so the feed replays any remaining race.
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await application.operations.threadEventWatermark(
      namespace,
      threadId,
    );
    await application.operations.reconcile({ limit: 1_000 });
    const beforeActive = await application.operations.listForThread({
      namespace,
      threadId,
      states: ["accepted", "running"],
      limit: 1_000,
    });
    messages = await listMessages(collections, threadId, messageQuery);
    const after = await application.operations.threadEventWatermark(
      namespace,
      threadId,
    );
    await application.operations.reconcile({ limit: 1_000 });
    const afterActive = await application.operations.listForThread({
      namespace,
      threadId,
      states: ["accepted", "running"],
      limit: 1_000,
    });
    activeOperations = [...new Map(
      [...beforeActive, ...afterActive].map((operation) => [
        operation.operationId,
        operation,
      ]),
    ).values()];
    if (before === after) {
      eventPosition = after;
      break;
    }
    eventPosition = before;
  }
  const hasMore = messages.length > limit;
  messages = Object.freeze(messages.slice(0, limit));
  const includeValues = queryTexts(request.query, "include") ?? [];
  const allowedIncludes = new Set<EventNativeHistoryInclude>(["content"]);
  const invalidInclude = includeValues.find((value) =>
    !allowedIncludes.has(value as EventNativeHistoryInclude)
  );
  if (invalidInclude) {
    throw appError(
      400,
      "invalid_query",
      `include must contain only: ${[...allowedIncludes].join(", ")}.`,
    );
  }
  const included = await createEventNativeMessageHistoryIncluded(
    application,
    namespace,
    messages,
    new Set(includeValues as readonly EventNativeHistoryInclude[]),
  );
  const replayCursor = await application.operationCheckpoint({
    namespace,
    databaseSchema: application.config.databaseSchema,
    operationIds: activeOperations.map((operation) => operation.operationId),
    cursor: encodeOperationReplayCursor({
      ...(eventPosition ? { eventPosition } : {}),
    }),
  });
  return {
    status: 200,
    data: messages,
    ...(included ? { included } : {}),
    pageInfo: Object.freeze({
      ...(hasMore
        ? { next: messages.at(-1)?.id, hasMore: true }
        : { hasMore: false }),
      replayCursor,
      activeOperationIds: Object.freeze(
        activeOperations.map((operation) => operation.operationId),
      ),
    }),
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

type ActivityDeliveryEntry = Readonly<{
  delivery: ThreadActivityDelivery;
  foreground: boolean;
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

/**
 * Activity represents one logical run, rather than every delivery ever
 * created for a Thread. Older Events can predate correlation IDs, so keep
 * each missing identifier isolated instead of accidentally merging them.
 */
function activityGroupKey(event: DurableEvent): string {
  const correlationId = event.correlationId.trim();
  return correlationId ? `correlation:${correlationId}` : `event:${event.id}`;
}

async function threadActivity(
  application: CopilotzApplication,
  namespace: string,
  thread: ConversationThread,
  request: EventNativeAppRequest,
): Promise<EventNativeAppResponse> {
  const pageSize = Math.min(
    queryNumber(request.query, "limit") ?? 1_000,
    1_000,
  );
  const latest = (await application.events.list({
    namespace,
    threadId: thread.id,
    order: "desc",
    limit: 1,
  }))[0];
  const activeGroup = latest ? activityGroupKey(latest) : undefined;
  const scopedEvents: DurableEvent[] = [];
  if (latest && activeGroup) {
    const correlationId = latest.correlationId.trim();
    if (!correlationId) {
      scopedEvents.push(latest);
    } else {
      let afterPosition: string | undefined;
      while (true) {
        const page = await application.events.list({
          namespace,
          threadId: thread.id,
          correlationId,
          ...(afterPosition ? { afterPosition } : {}),
          limit: pageSize,
        });
        scopedEvents.push(...page);
        if (page.length < pageSize) break;
        afterPosition = page.at(-1)?.position;
        if (!afterPosition) break;
      }
    }
  }
  const deliveryEntries = (
    await Promise.all(
      scopedEvents.map(async (event) =>
        (await application.deliveries.list({
          namespace,
          eventId: event.id,
          limit: 1_000,
        })).map((delivery): ActivityDeliveryEntry =>
          Object.freeze({
            delivery: activityDelivery(event, delivery),
            foreground: !delivery.settlementScopeId.startsWith("detached:"),
          })
        )
      ),
    )
  ).flat();
  // Detached processors are durable background work (for example memory
  // reservation), not work that keeps a conversation turn in progress.
  const foregroundDeliveries = deliveryEntries.filter((entry) =>
    entry.foreground
  ).map((entry) => entry.delivery);
  const active = foregroundDeliveries.filter((delivery) =>
    delivery.status === "pending" || delivery.status === "leased" ||
    delivery.status === "retry_wait"
  );
  const failures = foregroundDeliveries.filter((delivery) =>
    delivery.status === "dead_letter"
  ).sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const updatedAt = foregroundDeliveries.reduce(
    (latest, delivery) =>
      delivery.updatedAt > latest ? delivery.updatedAt : latest,
    scopedEvents.reduce(
      (latest, event) => event.createdAt > latest ? event.createdAt : latest,
      thread.updatedAt,
    ),
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
  const collections = application.collections.withScope({ namespace });
  if (request.method === "GET" && path.length === 0) {
    const limit = queryNumber(request.query, "limit");
    const statuses = queryTexts(request.query, "status");
    const threads = await listThreads(collections, {
      participantId: queryText(request.query, "participantId"),
      status: statuses,
      after: queryText(request.query, "after"),
      limit,
      order: queryChoice(request.query, "order", ["asc", "desc"]),
    });
    return { status: 200, data: threads, pageInfo: nextPage(threads, limit) };
  }
  if (path.length === 1 && request.method === "GET") {
    return await threadResponse(
      namespace,
      await getThread(collections, path[0]),
    );
  }
  if (
    path.length === 2 && path[1] === "activity" && request.method === "GET"
  ) {
    const thread = await getThread(collections, path[0]);
    if (!thread) {
      throw appError(404, "thread_not_found", "Thread was not found.");
    }
    return await threadActivity(application, namespace, thread, request);
  }
  if (
    path.length === 2 && path[1] === "feed" && request.method === "GET"
  ) {
    const thread = await getThread(collections, path[0]);
    if (!thread) {
      throw appError(404, "thread_not_found", "Thread was not found.");
    }
    await application.operations.reconcile({ limit: 1_000 });
    const requested = queryTexts(request.query, "operationId");
    const operations = requested?.length
      ? await application.operations.list({
        namespace,
        operationIds: requested,
        limit: requested.length,
      })
      : await application.operations.listForThread({
        namespace,
        threadId: thread.id,
        states: ["accepted", "running"],
        limit: 1_000,
      });
    if (
      requested &&
      (operations.length !== new Set(requested).size ||
        !(await Promise.all(
          requested.map((operationId) =>
            application.operations.belongsToThread(
              namespace,
              operationId,
              thread.id,
            )
          ),
        )).every(Boolean))
    ) {
      throw appError(
        404,
        "operation_not_found",
        "Operation was not found in this Thread.",
      );
    }
    const replayCursor = header(request.headers, "last-event-id");
    const attachments = await Promise.all(
      operations.map(async (operation) =>
        Object.freeze({
          operationId: operation.operationId,
          threadId: thread.id,
          attachment: await application.attach({
            operationId: operation.operationId,
            namespace,
            databaseSchema: application.config.databaseSchema,
            ...(replayCursor ? { cursor: replayCursor } : {}),
          }),
        })
      ),
    );
    return {
      status: 200,
      data: mergeOperationAttachments(attachments, replayCursor),
    };
  }
  if (
    path.length === 2 && path[1] === "events" && request.method === "GET"
  ) {
    const thread = await getThread(collections, path[0]);
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
  throw appError(404, "route_not_found", "Thread route was not found.");
}

async function handleParticipants(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  const collections = application.collections.withScope({ namespace });
  if (request.method === "GET" && path.length === 0) {
    const limit = queryNumber(request.query, "limit");
    const participantType = queryChoice<Participant["participantType"]>(
      request.query,
      "type",
      ["human", "agent", "tool", "job"],
    );
    const values = await collections.participant.list({
      ...(participantType ? { where: { participantType } } : {}),
      after: queryText(request.query, "after"),
      limit,
    });
    const participants = values.map(projectParticipant);
    return {
      status: 200,
      data: participants,
      pageInfo: nextPage(participants, limit),
    };
  }
  if (path.length !== 1) {
    throw appError(404, "route_not_found", "Participant route was not found.");
  }
  const [byExternalId] = await collections.participant.queries.byExternalId({
    externalId: path[0],
  });
  const participantRecord = byExternalId ??
    await collections.participant.get({ id: path[0] });
  const participant = participantRecord
    ? projectParticipant(participantRecord)
    : null;
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
    return {
      status: 200,
      data: Object.freeze([
        ...new Set(
          Object.values(application.plugins.collections).map((definition) =>
            definition.name
          ),
        ),
      ]),
    };
  }
  const name = path[0];
  if (!name) {
    throw appError(404, "route_not_found", "Collection route was not found.");
  }
  const collectionAlias = Object.entries(application.plugins.collections)
    .find(([, definition]) => definition.name === name)?.[0] ?? name;
  const scopedCollections = application.collections.withScope({ namespace });
  const collection = scopedCollections[name] ?? scopedCollections[
    collectionAlias
  ];
  if (!collection) {
    throw appError(
      404,
      "collection_not_found",
      `Collection '${name}' was not found.`,
    );
  }
  if (request.method === "GET" && path.length === 1) {
    const limit = queryNumber(request.query, "limit");
    const values = await collection.list({
      after: queryText(request.query, "after"),
      limit,
      where: queryObject(request.query, "where"),
    });
    return { status: 200, data: values, pageInfo: nextPage(values, limit) };
  }
  if (request.method === "POST" && path.length === 1) {
    const created = await collection.create(record(request.body), {
      operationKey: header(request.headers, "idempotency-key") ??
        `http:${name}:create:${crypto.randomUUID()}`,
      identity: mutationIdentity(request),
    });
    return { status: 201, data: created };
  }
  if (
    request.method === "QUERY" && path.length === 3 && path[1] === "queries"
  ) {
    const namedQuery = collection.queries[path[2]];
    if (!namedQuery) {
      throw appError(
        404,
        "query_not_found",
        "Collection query was not found.",
      );
    }
    return { status: 200, data: await namedQuery(record(request.body)) };
  }
  const id = path[1];
  if (
    id && request.method === "POST" && path.length === 4 &&
    path[2] === "commands"
  ) {
    const command = collection.commands[path[3]];
    if (!command) {
      throw appError(
        404,
        "command_not_found",
        "Collection command was not found.",
      );
    }
    const commanded = await command({ ...record(request.body), id }, {
      identity: mutationIdentity(request),
    });
    return { status: 200, data: commanded };
  }
  if (!id || path.length !== 2) {
    throw appError(404, "route_not_found", "Collection route was not found.");
  }
  if (request.method === "GET") {
    const value = await collection.get({ id });
    if (!value) {
      throw appError(404, "record_not_found", "Record was not found.");
    }
    return { status: 200, data: value };
  }
  if (request.method === "PATCH" || request.method === "PUT") {
    const updated = await collection.update({
      id,
      set: record(request.body),
    }, { identity: mutationIdentity(request) });
    return { status: 200, data: updated };
  }
  if (request.method === "DELETE") {
    await collection.delete({ id }, { identity: mutationIdentity(request) });
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
  const asset = eventNativeAsset(body.asset);
  if (format === "metadata") return { status: 200, data: asset };
  const encoded = base64(body.bytes);
  if (format === "base64") {
    return {
      status: 200,
      data: { asset, base64: encoded },
    };
  }
  if (format === "dataUrl") {
    return {
      status: 200,
      data: {
        asset,
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

function publicOperationStatus(
  status: NonNullable<
    Awaited<ReturnType<CopilotzApplication["operationStatus"]>>
  >,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    operationId: status.operationId,
    namespace: status.namespace,
    correlationId: status.correlationId,
    state: status.state,
    acceptedAt: status.acceptedAt,
    updatedAt: status.updatedAt,
    ...(status.completedAt ? { completedAt: status.completedAt } : {}),
  });
}

async function handleOperations(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  const operationId = path[0]?.trim();
  if (!operationId) {
    throw appError(404, "route_not_found", "Operation route was not found.");
  }
  if (request.method === "GET" && path.length === 1) {
    const status = await application.operationStatus({
      operationId,
      namespace,
      databaseSchema: application.config.databaseSchema,
    });
    if (!status) {
      throw appError(404, "operation_not_found", "Operation was not found.");
    }
    return { status: 200, data: publicOperationStatus(status) };
  }
  if (request.method === "GET" && path.length === 2 && path[1] === "outputs") {
    const replayCursor = header(request.headers, "last-event-id");
    const attachment = await application.attach({
      operationId,
      namespace,
      databaseSchema: application.config.databaseSchema,
      ...(replayCursor ? { cursor: replayCursor } : {}),
    });
    const status = await application.operationStatus({
      operationId,
      namespace,
      databaseSchema: application.config.databaseSchema,
    });
    const threadId = typeof status?.metadata.threadId === "string"
      ? status.metadata.threadId
      : undefined;
    return {
      status: 200,
      data: mergeOperationAttachments([{
        attachment,
        operationId,
        ...(threadId ? { threadId } : {}),
      }], replayCursor ?? attachment.replayCursor),
    };
  }
  if (request.method === "DELETE" && path.length === 1) {
    const reason = typeof record(request.body).reason === "string"
      ? String(record(request.body).reason)
      : undefined;
    const status = await application.cancelOperation({
      operationId,
      namespace,
      databaseSchema: application.config.databaseSchema,
      ...(reason ? { reason } : {}),
    });
    if (!status) {
      throw appError(404, "operation_not_found", "Operation was not found.");
    }
    return { status: 200, data: publicOperationStatus(status) };
  }
  throw appError(404, "route_not_found", "Operation route was not found.");
}

async function handleChannels(
  application: CopilotzApplication,
  namespace: string,
  request: EventNativeAppRequest,
  path: readonly string[],
): Promise<EventNativeAppResponse> {
  const channelId = path.length === 1 ? path[0]?.trim() : "";
  if (!channelId) {
    throw appError(404, "route_not_found", "Channel route was not found.");
  }
  const candidate = application.plugins.resources.channels?.[channelId];
  if (!candidate) {
    throw appError(
      404,
      "channel_not_found",
      `Channel '${channelId}' was not found.`,
    );
  }
  const channel = defineChannelResource(candidate as never);
  const adapter = application.plugins.adapters.channels?.[channelId] as
    | ChannelAdapter
    | undefined;
  if (!adapter || typeof adapter.accept !== "function") {
    throw appError(
      404,
      "channel_not_found",
      `Channel Adapter '${channelId}' was not found.`,
    );
  }
  const rawBody = request.context?.rawBody;
  const channelRequest: ChannelRequest = Object.freeze({
    method: request.method,
    headers: Object.freeze({ ...(request.headers ?? {}) }),
    ...(request.query ? { query: request.query } : {}),
    body: request.body,
    ...(rawBody instanceof Uint8Array ? { rawBody: rawBody.slice() } : {}),
    ...(request.context ? { context: request.context } : {}),
  });
  const abort = new AbortController();
  let accepted: ChannelAcceptResult;
  try {
    accepted = acceptedChannels(
      await adapter.accept(channelRequest, {
        namespace,
        channelId,
        channel,
        signal: abort.signal,
        now: () => new Date(),
      }),
    );
  } catch (error) {
    abort.abort(error);
    throw error;
  }
  if ((accepted.status ?? 200) >= 400 && accepted.occurrences.length > 0) {
    abort.abort("channel_accept_rejected_occurrences");
    throw appError(
      500,
      "invalid_channel_accept",
      "A rejected Channel request cannot contain accepted occurrences.",
    );
  }
  let envelopes: ApplicationSendInput[];
  try {
    const operationMetadata = record(request.context?.operationMetadata);
    envelopes = accepted.occurrences.map((occurrence) => {
      const envelope = channelIngress(channelId, occurrence, {
        namespace,
        databaseSchema: application.config.databaseSchema,
      });
      return Object.freeze({
        ...envelope,
        ...(Object.keys(operationMetadata).length
          ? { operationMetadata: structuredClone(operationMetadata) }
          : {}),
      });
    });
  } catch (error) {
    abort.abort(error);
    throw error;
  }
  if (channel.egress === "request-observation" && envelopes.length > 1) {
    abort.abort("channel_request_has_multiple_occurrences");
    throw appError(
      400,
      "multiple_request_occurrences",
      "A request-observation Channel must accept exactly one occurrence.",
    );
  }
  const handles: ApplicationSendHandle[] = [];
  try {
    for (const envelope of envelopes) {
      handles.push(await application.send(envelope));
    }
  } catch (error) {
    abort.abort(error);
    await Promise.allSettled(
      handles.map((handle) => handle.cancel("channel_accept_failed")),
    );
    throw error;
  }
  if (channel.egress === "request-observation" && handles.length > 0) {
    const handle = handles[0];
    const respondAsync = header(request.headers, "prefer")?.split(",").some(
      (preference) => preference.trim().toLowerCase() === "respond-async",
    ) ?? false;
    if (respondAsync) {
      const status = await application.operationStatus({
        operationId: handle.operationId,
        namespace,
        databaseSchema: application.config.databaseSchema,
      });
      await handle.detach("http_respond_async");
      const threadId = typeof status?.metadata.threadId === "string"
        ? status.metadata.threadId.trim()
        : "";
      const externalId = typeof status?.metadata.threadExternalId === "string"
        ? status.metadata.threadExternalId.trim()
        : typeof status?.metadata.externalThreadId === "string"
        ? status.metadata.externalThreadId.trim()
        : threadId;
      return {
        status: 202,
        headers: { "preference-applied": "respond-async" },
        data: Object.freeze({
          operationId: handle.operationId,
          status: status?.state === "accepted" ? "accepted" : "running",
          correlationId: handle.correlationId,
          replayCursor: handle.replayCursor,
          acceptedAt: status?.acceptedAt ?? new Date().toISOString(),
          ...(threadId
            ? { thread: Object.freeze({ id: threadId, externalId }) }
            : {}),
        }),
      };
    }
    const done = handle.done.finally(() => abort.abort());
    const output: EventNativeOutputStream = Object.freeze({
      type: EVENT_NATIVE_OUTPUT_STREAM,
      outputs: handle.outputs,
      done,
      operationId: handle.operationId,
      replayCursor: handle.replayCursor,
      async cancel(reason = "channel_request_cancelled") {
        abort.abort(reason);
        await handle.detach(reason);
      },
    });
    return { status: 200, data: output };
  }
  for (const handle of handles) void handle.done.catch(() => undefined);
  abort.abort("channel_accept_completed");
  return {
    status: accepted.status ?? (handles.length ? 202 : 200),
    data: accepted.response ?? {
      accepted: true,
      occurrences: handles.length,
      eventIds: Object.freeze(handles.map((handle) => handle.eventId)),
    },
  };
}

const ACCEPT_KEYS = new Set(["occurrences", "status", "response"]);

function acceptedChannels(value: unknown): ChannelAcceptResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Channel accept result must be a plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Channel accept result must be a plain object.");
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !ACCEPT_KEYS.has(key)) {
      throw new TypeError(
        `Channel accept result cannot declare '${String(key)}'.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Channel accept result.${key} must be a data property.`,
      );
    }
    if (descriptor.value === undefined) {
      throw new TypeError(`Channel accept result.${key} cannot be undefined.`);
    }
    snapshot[key] = descriptor.value;
  }
  const occurrences = snapshot.occurrences;
  if (
    !Array.isArray(occurrences) ||
    Object.getPrototypeOf(occurrences) !== Array.prototype ||
    Object.keys(occurrences).length !== occurrences.length ||
    Reflect.ownKeys(occurrences).some((key) =>
      key !== "length" &&
      (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) ||
        Number(key) >= occurrences.length)
    )
  ) {
    throw new TypeError("Channel accept occurrences must be a dense array.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(occurrences);
  const normalized = Object.freeze(Array.from(
    { length: occurrences.length },
    (_, index) => {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `Channel accept occurrences[${index}] must be a data property.`,
        );
      }
      const occurrence = descriptor.value;
      if (!occurrence || typeof occurrence !== "object") {
        throw new TypeError("Channel occurrence must be a plain object.");
      }
      return occurrence as ChannelIngressOccurrence;
    },
  ));
  const status = snapshot.status;
  if (
    status !== undefined &&
    (!Number.isSafeInteger(status) || Number(status) < 100 ||
      Number(status) > 599)
  ) throw new TypeError("Channel accept status must be an HTTP status.");
  return Object.freeze({
    occurrences: normalized,
    ...(status !== undefined ? { status: Number(status) } : {}),
    ...(snapshot.response !== undefined ? { response: snapshot.response } : {}),
  });
}

/** Creates the queue-free, graph/event-native framework-neutral HTTP facade. */
export function createEventNativeApp(
  application: CopilotzApplication,
  options: CreateEventNativeAppOptions = {},
): EventNativeApp {
  const applicationScopes = new Map<string, Promise<CopilotzApplication>>();
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
  const resources = Object.freeze([
    { name: "agents", methods: Object.freeze(["GET"]) },
    { name: "assets", methods: Object.freeze(["GET"]) },
    {
      name: "channels",
      methods: Object.freeze(["GET", "POST", "PATCH", "PUT", "DELETE"]),
    },
    {
      name: "collections",
      methods: Object.freeze([
        "GET",
        "POST",
        "PATCH",
        "PUT",
        "DELETE",
        "QUERY",
      ]),
    },
    { name: "deliveries", methods: Object.freeze(["GET", "POST"]) },
    { name: "events", methods: Object.freeze(["GET"]) },
    { name: "operations", methods: Object.freeze(["GET", "DELETE"]) },
    {
      name: "participants",
      methods: Object.freeze(["GET"]),
    },
    {
      name: "threads",
      methods: Object.freeze(["GET"]),
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
            data: Object.values(scoped.plugins.resources.agents ?? {})
              .filter((candidate): candidate is AgentResource =>
                !!candidate && typeof candidate === "object"
              )
              .map(publicAgent),
          };
        case "assets":
          return await handleAssets(scoped, namespace, request, path);
        case "channels":
          return await handleChannels(
            scoped,
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
        case "operations":
          return await handleOperations(scoped, namespace, request, path);
        case "deliveries":
          return await handleDeliveries(scoped, namespace, request, path);
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
