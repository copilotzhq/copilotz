/**
 * Application layer for Copilotz.
 *
 * `withApp(copilotz)` attaches an `.app` property that aggregates all handler
 * factories, provides a pattern-based route table, and exposes a universal
 * `handle()` dispatcher for HTTP-style requests.
 *
 * @module
 */

import type { Copilotz } from "@/index.ts";
import type { RunHandle, RunOptions } from "@/runtime/index.ts";
import { listPublicAgents } from "@/utils/list-agents.ts";
import type { FeatureEntry } from "@/runtime/loaders/resources.ts";
import type {
  GraphMutationOptions,
  MessageHistoryPageInfo,
} from "@/database/operations/index.ts";
import type { CollectionPageInfo } from "@/database/collections/types.ts";
import { createChannelHandlers } from "./channels.ts";
import type {
  ChannelAdapterRequest,
  ChannelHandlers,
  ChannelRouteSpec,
  IngressEnvelope,
} from "./channels.ts";
import {
  getSerializableThreadMetadata,
  mergeThreadMetadata,
} from "@/runtime/thread-metadata.ts";

import { createThreadHandlers } from "./threads.ts";
import type { ThreadHandlers } from "./threads.ts";
import { createMessageHandlers } from "./messages.ts";
import type { MessageHandlers } from "./messages.ts";
import { createCollectionHandlers } from "./collections.ts";
import type { CollectionHandlers } from "./collections.ts";
import { createAssetHandlers } from "./assets.ts";
import type { AssetHandlers } from "./assets.ts";
import { createGraphHandlers } from "./graph.ts";
import type { GraphHandlers } from "./graph.ts";
import { createEventHandlers } from "./events.ts";
import type { EventHandlers } from "./events.ts";
import { withSchema } from "@/database/schema-context.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Framework-neutral request shape handled by {@link CopilotzApp.handle}. */
export interface AppRequest {
  resource: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string[];
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: Uint8Array;
  callback?: (event: unknown) => void;
  context?: AppRequestContext;
}

/** Per-request tenant, schema, and adapter-specific context. */
export interface AppRequestContext extends Record<string, unknown> {
  /**
   * Tenant/application namespace for this request.
   *
   * Server adapters should set this from authenticated app context when the
   * tenant is not fixed by `CopilotzConfig.namespace`.
   */
  namespace?: string;
  /**
   * PostgreSQL schema for this request.
   *
   * Server adapters should set this from authenticated tenant context when
   * using schema-level isolation.
   */
  schema?: string;
}

/**
 * Canonical response shape returned by {@link CopilotzApp.handle}.
 *
 * HTTP adapters must serialize this as a JSON body that always carries
 * `{ data }`, plus `pageInfo` when the route returned a paginated result.
 * Keeping this mapping 1:1 with the HTTP body means frontends always read
 * `body.data` (and `body.pageInfo` for paginated endpoints).
 */
export interface AppResponse {
  status: number;
  data?: unknown;
  /** Only set by paginated endpoints (e.g. `GET /threads/:id/messages`). */
  pageInfo?: MessageHistoryPageInfo | CollectionPageInfo;
}

/** Handlers for public agent discovery. */
export interface AgentHandlers {
  list: () => unknown[];
}

/** Describes one resource exposed by the app dispatcher. */
export interface ResourceDescriptor {
  name: string;
  methods: string[];
}

/** Aggregated server helper facade attached by {@link withApp}. */
export interface CopilotzApp {
  threads: ThreadHandlers;
  messages: MessageHandlers;
  collections: CollectionHandlers;
  assets: AssetHandlers;
  graph: GraphHandlers;
  events: EventHandlers;
  agents: AgentHandlers;
  channels: ChannelHandlers;
  handle(request: AppRequest): Promise<AppResponse>;
  resources(): ResourceDescriptor[];
}

export interface AppGeneratedEventLogContext {
  route: ChannelRouteSpec;
  threadId: string;
  message: IngressEnvelope["message"];
  requestContext?: AppRequestContext;
}

export type AppGeneratedEventLogFunction = (
  event: unknown,
  context: AppGeneratedEventLogContext,
) => void | Promise<void>;

export interface AppGeneratedEventLogOptions {
  /**
   * Only log these event types. Omit or pass an empty array to log all durable
   * generated event types. Explicitly listed event types are logged even when
   * they are excluded by default.
   */
  eventTypes?: readonly string[];
  /** Never log these event types, even when they are listed in `eventTypes`. */
  excludeEventTypes?: readonly string[];
  /**
   * Optional structured logger. When omitted, events are written to
   * `console.log` as one inline JSON string.
   */
  logger?: AppGeneratedEventLogFunction;
}

export type AppGeneratedEventLogger =
  | boolean
  | AppGeneratedEventLogFunction
  | AppGeneratedEventLogOptions;

export interface AppRunOptionsContext {
  namespace?: string;
  schema?: string;
  route: ChannelRouteSpec;
  envelope: IngressEnvelope;
  copilotz: Copilotz;
}

/** Options for namespace and schema resolution in {@link withApp}. */
export interface WithAppOptions {
  /**
   * Expose admin feature actions as first-class `/admin/:action` app routes.
   *
   * Defaults to false. Clients should only enable this after adding their own
   * authentication and authorization guard before dispatching requests.
   */
  exposeAdminRoutes?: boolean;
  /**
   * Resolve the tenant/application namespace for each app request.
   *
   * Resolution order is:
   * 1. `request.context.namespace`
   * 2. `resolveNamespace(request)`
   * 3. `copilotz.config.namespace`
   */
  resolveNamespace?: (
    request: AppRequest,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Resolve the PostgreSQL schema for each app request.
   *
   * Resolution order is:
   * 1. `request.context.schema`
   * 2. `resolveSchema(request)`
   * 3. `copilotz.config.dbConfig.defaultSchema`
   */
  resolveSchema?: (
    request: AppRequest,
  ) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Resolve additional runtime options for channel-delivered runs.
   *
   * Namespace and schema are still controlled by the app request/envelope and
   * are applied after this hook, so tenant isolation remains authoritative.
   */
  resolveRunOptions?: (
    request: AppRequest,
    context: AppRunOptionsContext,
  ) =>
    | Partial<RunOptions>
    | null
    | undefined
    | Promise<Partial<RunOptions> | null | undefined>;
  /**
   * Log runtime events generated by app channel deliveries.
   *
   * Set to `true` to write compact event records to `console.log`, or provide a
   * function to capture structured events in application logs. By default, all
   * durable generated event types are logged, while ephemeral stream-only event
   * types such as `TOKEN` and `ASSET_CREATED` are skipped.
   */
  logGeneratedEvents?: AppGeneratedEventLogger;
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

interface Route {
  resource: string;
  method: string;
  pattern: string[];
  action: (
    ctx: RouteContext,
    params: Record<string, string>,
  ) => Promise<AppResponse>;
}

interface RouteContext {
  handlers: {
    threads: ThreadHandlers;
    messages: MessageHandlers;
    collections: CollectionHandlers;
    assets: AssetHandlers;
    graph: GraphHandlers;
    events: EventHandlers;
    agents: AgentHandlers;
    channels: ChannelHandlers;
  };
  copilotz: Copilotz;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string>;
  rawBody?: Uint8Array;
  callback?: (event: unknown) => void;
  context?: AppRequestContext;
  namespace?: string;
  schema?: string;
  appOptions: WithAppOptions;
  method: string;
}

function matchRoute(
  routes: Route[],
  resource: string,
  method: string,
  path: string[],
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.resource !== resource) continue;
    if (route.method !== "*" && route.method !== method) continue;
    if (route.pattern.length !== path.length) continue;

    const params: Record<string, string> = {};
    let match = true;
    for (let i = 0; i < route.pattern.length; i++) {
      if (route.pattern[i].startsWith(":")) {
        params[route.pattern[i].slice(1)] = decodeURIComponent(path[i]);
      } else if (route.pattern[i] !== path[i]) {
        match = false;
        break;
      }
    }
    if (match) return { route, params };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Built-in route table
// ---------------------------------------------------------------------------

function buildRoutes(): Route[] {
  return [
    // ---- agents ----
    {
      resource: "agents",
      method: "GET",
      pattern: [],
      action: async (ctx) => ({
        status: 200,
        data: ctx.handlers.agents.list(),
      }),
    },

    // ---- assets ----
    {
      resource: "assets",
      method: "GET",
      pattern: [":id"],
      action: async (ctx, p) => {
        const format = ctx.query.format as string || "dataUrl";
        if (format === "base64") {
          const result = await ctx.handlers.assets.getBase64(p.id, {
            namespace: ctx.namespace,
          });
          return { status: 200, data: { assetId: p.id, ...result } };
        }
        const result = await ctx.handlers.assets.getDataUrl(p.id, {
          namespace: ctx.namespace,
        });
        return { status: 200, data: { assetId: p.id, ...result } };
      },
    },

    // ---- threads ----
    {
      resource: "threads",
      method: "GET",
      pattern: [],
      action: async (ctx) => {
        const participantId = ctx.query.participantId as string;
        if (!participantId) {
          throw {
            status: 400,
            message: "participantId query parameter is required",
          };
        }
        return {
          status: 200,
          data: await ctx.handlers.threads.list(participantId, {
            status: asEnum(ctx.query.status as string, [
              "active",
              "archived",
              "all",
            ]),
            limit: asNumber(ctx.query.limit),
            offset: asNumber(ctx.query.offset),
            order: asEnum(ctx.query.order as string, ["asc", "desc"]),
            namespace: ctx.namespace,
          }),
        };
      },
    },
    {
      resource: "threads",
      method: "POST",
      pattern: [],
      action: async (ctx) => {
        const body = ctx.body as Record<string, unknown>;
        const threadId = typeof body.id === "string" ? body.id : undefined;
        const threadData = {
          ...body,
          namespace: ctx.namespace ??
            (typeof body.namespace === "string" ? body.namespace : undefined),
        } as Parameters<ThreadHandlers["findOrCreate"]>[1];
        return {
          status: 201,
          data: await ctx.handlers.threads.findOrCreate(
            threadId,
            threadData,
          ),
        };
      },
    },
    {
      resource: "threads",
      method: "GET",
      pattern: [":id"],
      action: async (ctx, p) => {
        const thread = await ctx.handlers.threads.getById(p.id);
        if (!thread) throw { status: 404, message: "Thread not found" };
        return { status: 200, data: thread };
      },
    },
    {
      resource: "threads",
      method: "PATCH",
      pattern: [":id"],
      action: async (ctx, p) => {
        const updated = await ctx.handlers.threads.update(
          p.id,
          ctx.body as Record<string, unknown>,
        );
        if (!updated) throw { status: 404, message: "Thread not found" };
        return { status: 200, data: updated };
      },
    },
    {
      resource: "threads",
      method: "DELETE",
      pattern: [":id"],
      action: async (ctx, p) => {
        await ctx.handlers.threads.delete(p.id);
        return { status: 204 };
      },
    },
    {
      resource: "threads",
      method: "POST",
      pattern: [":id"],
      action: async (ctx, p) => {
        const body = ctx.body as Record<string, unknown>;
        return {
          status: 200,
          data: await (ctx.handlers.threads as any).archive(
            p.id,
            (body.summary as string) ?? "",
          ),
        };
      },
    },

    // ---- threads/:id/messages ----
    {
      resource: "threads",
      method: "GET",
      pattern: [":id", "messages"],
      action: async (ctx, p) => {
        const limit = asNumber(ctx.query.limit);
        const before = ctx.query.before as string | undefined;
        const h = ctx.handlers.messages;
        if (typeof h.listPageFromGraph === "function") {
          const page = await h.listPageFromGraph(p.id, { limit, before });
          return {
            status: 200,
            data: page.data,
            pageInfo: page.pageInfo,
          };
        }
        return {
          status: 200,
          data: await h.listFromGraph(p.id, limit),
        };
      },
    },
    {
      resource: "threads",
      method: "DELETE",
      pattern: [":id", "messages"],
      action: async (ctx, p) => {
        await ctx.handlers.messages.deleteForThread(p.id);
        return { status: 204 };
      },
    },
    {
      resource: "threads",
      method: "POST",
      pattern: [":id", "messages", ":messageId", "edit"],
      action: async (ctx, p) => {
        const body = ctx.body as Record<string, unknown>;
        const content = typeof body.content === "string" ? body.content : "";
        if (!content.trim()) {
          throw { status: 400, message: "Edited message content is required" };
        }
        try {
          return {
            status: 201,
            data: await ctx.handlers.messages.edit(
              p.id,
              p.messageId,
              content,
            ),
          };
        } catch (error) {
          const message = error instanceof Error
            ? error.message
            : String(error);
          if (
            message === "Thread not found." || message === "Message not found."
          ) {
            throw { status: 404, message };
          }
          if (
            message === "Only user messages can be edited." ||
            message === "Edited message content is required."
          ) {
            throw { status: 400, message };
          }
          throw error;
        }
      },
    },

    // ---- threads/:id/activity ----
    {
      resource: "threads",
      method: "GET",
      pattern: [":id", "activity"],
      action: async (ctx, p) => {
        const rawMinPriority = ctx.query.minPriority;
        const minPriority = typeof rawMinPriority === "string" &&
            rawMinPriority.trim().length > 0
          ? Number(rawMinPriority)
          : undefined;
        const includeEvents = ctx.query.includeEvents === "true";

        return {
          status: 200,
          data: await ctx.copilotz.ops.getThreadActivity(p.id, {
            namespace: ctx.namespace,
            includeEvents,
            ...(Number.isFinite(minPriority) ? { minPriority } : {}),
          }),
        };
      },
    },

    // ---- threads/:id/events ----
    {
      resource: "threads",
      method: "GET",
      pattern: [":id", "events"],
      action: async (ctx, p) => {
        const h = ctx.handlers.events;
        if (ctx.query.status === "processing") {
          return { status: 200, data: await h.getProcessing(p.id) };
        }
        return {
          status: 200,
          data: await h.getNextPending(p.id, ctx.namespace),
        };
      },
    },
    {
      resource: "threads",
      method: "POST",
      pattern: [":id", "events"],
      action: async (ctx, p) => ({
        status: 201,
        data: await ctx.handlers.events.enqueue(p.id, ctx.body as any),
      }),
    },

    // ---- collections ----
    {
      resource: "collections",
      method: "GET",
      pattern: [],
      action: async (ctx) => ({
        status: 200,
        data: ctx.handlers.collections.listCollections(),
      }),
    },
    {
      resource: "collections",
      method: "GET",
      pattern: [":collection"],
      action: async (ctx, p) => {
        const q = ctx.query.q as string | undefined;
        const namespace = requireTenantNamespace(ctx);
        if (q) {
          return {
            status: 200,
            data: await ctx.handlers.collections.search(p.collection, q, {
              namespace,
              limit: asNumber(ctx.query.limit),
              threshold: asNumber(ctx.query.threshold),
              filter: parseJsonParam(ctx.query.filter),
              populate: parseListParam(ctx.query.populate),
            }),
          };
        }
        const result = await ctx.handlers.collections.list(p.collection, {
          namespace,
          filter: parseJsonParam(ctx.query.filter),
          limit: asNumber(ctx.query.limit),
          offset: asNumber(ctx.query.offset),
          before: typeof ctx.query.before === "string"
            ? ctx.query.before
            : undefined,
          after: typeof ctx.query.after === "string"
            ? ctx.query.after
            : undefined,
          sort: parseSortParam(ctx.query.sort),
          populate: parseListParam(ctx.query.populate),
        });
        return {
          status: 200,
          data: result.data,
          ...(result.pageInfo ? { pageInfo: result.pageInfo } : {}),
        };
      },
    },
    {
      resource: "collections",
      method: "POST",
      pattern: [":collection"],
      action: async (ctx, p) => ({
        status: 201,
        data: await ctx.handlers.collections.create(
          p.collection,
          ctx.body as Record<string, unknown>,
          { namespace: requireTenantNamespace(ctx) },
        ),
      }),
    },
    {
      resource: "collections",
      method: "GET",
      pattern: [":collection", ":id"],
      action: async (ctx, p) => {
        const result = await ctx.handlers.collections.getById(
          p.collection,
          p.id,
          {
            namespace: requireTenantNamespace(ctx),
            populate: parseListParam(ctx.query.populate),
          },
        );
        if (!result) {
          throw { status: 404, message: `${p.collection} not found` };
        }
        return { status: 200, data: result };
      },
    },
    {
      resource: "collections",
      method: "PUT",
      pattern: [":collection", ":id"],
      action: async (ctx, p) => ({
        status: 200,
        data: await ctx.handlers.collections.update(
          p.collection,
          p.id,
          ctx.body as Record<string, unknown>,
          { namespace: requireTenantNamespace(ctx) },
        ),
      }),
    },
    {
      resource: "collections",
      method: "DELETE",
      pattern: [":collection", ":id"],
      action: async (ctx, p) => {
        await ctx.handlers.collections.delete(p.collection, p.id, {
          namespace: requireTenantNamespace(ctx),
        });
        return { status: 204 };
      },
    },

    // ---- graph ----
    {
      resource: "graph",
      method: "POST",
      pattern: ["search"],
      action: async (ctx) => ({
        status: 200,
        data: await ctx.handlers.graph.search({
          ...(ctx.body as Record<string, unknown> | undefined),
          namespace: requireTenantNamespace(ctx),
        }),
      }),
    },
    {
      resource: "graph",
      method: "GET",
      pattern: ["nodes", ":id"],
      action: async (ctx, p) => {
        const node = await ctx.handlers.graph.getNodeById(p.id);
        if (!node) throw { status: 404, message: "Node not found" };
        return { status: 200, data: node };
      },
    },
    {
      resource: "graph",
      method: "PATCH",
      pattern: ["nodes", ":id"],
      action: async (ctx, p) => {
        const mutation = graphMutationOptions(ctx);
        const node = await ctx.handlers.graph.updateNode(
          p.id,
          graphMutationBody(ctx.body),
          mutation,
        );
        if (!node) throw { status: 404, message: "Node not found" };
        return { status: 200, data: node };
      },
    },
    {
      resource: "graph",
      method: "DELETE",
      pattern: ["nodes", ":id"],
      action: async (ctx, p) => {
        await ctx.handlers.graph.deleteNode(p.id, graphMutationOptions(ctx));
        return { status: 204 };
      },
    },
    {
      resource: "graph",
      method: "GET",
      pattern: ["nodes", ":id", "edges"],
      action: async (ctx, p) => {
        const direction = asEnum(ctx.query.direction as string, [
          "in",
          "out",
          "both",
        ]);
        const types = Array.isArray(ctx.query.type)
          ? ctx.query.type as string[]
          : ctx.query.type
          ? [ctx.query.type as string]
          : undefined;
        return {
          status: 200,
          data: await ctx.handlers.graph.getEdges(p.id, { direction, types }),
        };
      },
    },
    {
      resource: "graph",
      method: "GET",
      pattern: ["nodes", ":id", "related"],
      action: async (ctx, p) => ({
        status: 200,
        data: await ctx.handlers.graph.findRelated(p.id, {
          depth: asNumber(ctx.query.depth),
        }),
      }),
    },
    {
      resource: "graph",
      method: "GET",
      pattern: ["nodes"],
      action: async (ctx) => ({
        status: 200,
        data: await ctx.handlers.graph.listNodes(requireTenantNamespace(ctx), {
          type: ctx.query.type as string | undefined,
        }),
      }),
    },

    // ---- channels ----
    {
      resource: "channels",
      method: "*",
      pattern: [":ingress"],
      action: async (ctx, p) =>
        await handleChannelRoute(ctx, {
          ingress: p.ingress,
          egress: p.ingress,
        }),
    },
    {
      resource: "channels",
      method: "*",
      pattern: [":ingress", "to", ":egress"],
      action: async (ctx, p) =>
        await handleChannelRoute(ctx, {
          ingress: p.ingress,
          egress: p.egress,
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNumber(val: unknown): number | undefined {
  if (val === undefined || val === null || val === "") return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

function asEnum<T extends string>(
  val: string | undefined,
  allowed: T[],
): T | undefined {
  if (!val) return undefined;
  return allowed.includes(val as T) ? (val as T) : undefined;
}

/** Parse a JSON-encoded query param into an object, returning undefined on failure. */
function parseJsonParam(val: unknown): Record<string, unknown> | undefined {
  if (!val || typeof val !== "string") return undefined;
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === "object" && parsed && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a sort query param like "name:asc,createdAt:desc" into a sort array. */
function parseSortParam(
  val: unknown,
): Array<[string, "asc" | "desc"]> | undefined {
  if (!val || typeof val !== "string") return undefined;
  const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map((part) => {
    const [field, dir] = part.split(":");
    return [
      field,
      dir === "desc" ? "desc" as const : "asc" as const,
    ];
  });
}

function parseListParam(val: unknown): string[] | undefined {
  if (!val || typeof val !== "string") return undefined;
  const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function asString(val: unknown): string | undefined {
  const candidate = Array.isArray(val) ? val[0] : val;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const exact = headers[name];
  if (typeof exact === "string") return exact;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function graphMutationBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const {
    threadId: _threadId,
    topicThreadId: _topicThreadId,
    traceId: _traceId,
    causationId: _causationId,
    correlationId: _correlationId,
    mutationMetadata: _mutationMetadata,
    ...updates
  } = body as Record<string, unknown>;
  return updates;
}

function graphMutationOptions(ctx: RouteContext): GraphMutationOptions {
  const body = bodyRecord(ctx.body);
  const threadId = asString(ctx.query.threadId) ??
    asString(ctx.query.topicThreadId) ??
    asString(body?.threadId) ??
    asString(body?.topicThreadId) ??
    asString(ctx.context?.threadId) ??
    asString(ctx.context?.topicThreadId) ??
    asString(headerValue(ctx.headers, "x-copilotz-thread-id")) ??
    asString(headerValue(ctx.headers, "x-copilotz-topic-id"));

  if (!threadId) {
    throw {
      status: 400,
      message:
        "Graph mutation requires a threadId queue topic. Pass threadId in the request body, query, context, or x-copilotz-thread-id header.",
    };
  }

  const metadata = body?.mutationMetadata &&
      typeof body.mutationMetadata === "object" &&
      !Array.isArray(body.mutationMetadata)
    ? body.mutationMetadata as Record<string, unknown>
    : undefined;

  return {
    threadId,
    namespace: requireTenantNamespace(ctx),
    traceId: asString(ctx.query.traceId) ?? asString(body?.traceId) ??
      asString(headerValue(ctx.headers, "x-copilotz-trace-id")) ?? null,
    causationId: asString(ctx.query.causationId) ??
      asString(body?.causationId) ??
      asString(headerValue(ctx.headers, "x-copilotz-causation-id")) ?? null,
    correlationId: asString(ctx.query.correlationId) ??
      asString(body?.correlationId) ??
      asString(headerValue(ctx.headers, "x-copilotz-correlation-id")) ?? null,
    metadata: metadata ?? null,
  };
}

function bodyRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : undefined;
}

function requireTenantNamespace(ctx: RouteContext): string {
  if (ctx.namespace && ctx.namespace.trim().length > 0) return ctx.namespace;
  throw {
    status: 400,
    message:
      "Tenant namespace is required. Set CopilotzConfig.namespace, AppRequest.context.namespace, or withApp(..., { resolveNamespace }).",
  };
}

async function handleChannelRoute(
  ctx: RouteContext,
  route: ChannelRouteSpec,
): Promise<AppResponse> {
  const ingress = ctx.handlers.channels.getIngress(route.ingress);
  if (!ingress) {
    throw {
      status: 404,
      message: `Unknown ingress channel: ${route.ingress}`,
    };
  }

  const egress = ctx.handlers.channels.getEgress(route.egress);
  if (!egress) {
    throw {
      status: 404,
      message: `Unknown egress channel: ${route.egress}`,
    };
  }

  const ingressRequest: ChannelAdapterRequest = {
    method: ctx.method,
    headers: ctx.headers,
    query: ctx.query,
    body: ctx.body,
    rawBody: ctx.rawBody,
    callback: ctx.callback,
    context: ctx.context,
    route,
  };

  const ingressResult = await ingress.handle(ingressRequest, ctx.copilotz);
  const envelopes = ingressResult.messages ?? [];

  if (envelopes.length === 0) {
    return {
      status: ingressResult.status ?? 200,
      data: ingressResult.response ?? { status: "ok" },
    };
  }

  const deliverEnvelope = async (envelope: IngressEnvelope): Promise<void> => {
    const envelopeNamespace = envelope.namespace ?? ctx.namespace;
    const envelopeSchema = envelope.schema ?? ctx.schema;
    const appRequest: AppRequest = {
      resource: "channels",
      method: ctx.method as AppRequest["method"],
      path: route.egress === route.ingress
        ? [route.ingress]
        : [route.ingress, "to", route.egress],
      query: ctx.query as AppRequest["query"],
      body: ctx.body,
      headers: ctx.headers,
      rawBody: ctx.rawBody,
      callback: ctx.callback,
      context: ctx.context,
    };
    const runDelivery = async () => {
      const message = applyThreadMetadataPatch(envelope);
      const thread = await resolveThreadForMessage(ctx.copilotz, message);
      const effectiveMetadata = mergeThreadMetadata(
        thread?.metadata,
        message.thread?.metadata,
      );
      await egress.validateThreadContext?.({
        metadata: getSerializableThreadMetadata(effectiveMetadata),
      });

      const extraRunOptions = await ctx.appOptions.resolveRunOptions?.(
        appRequest,
        {
          namespace: envelopeNamespace,
          schema: envelopeSchema,
          route,
          envelope,
          copilotz: ctx.copilotz,
        },
      );
      const handle = await ctx.copilotz.run(message, {
        ...(extraRunOptions ?? {}),
        namespace: envelopeNamespace,
        schema: envelopeSchema,
      });
      const loggedHandle = withGeneratedEventLogging(
        handle,
        ctx.appOptions.logGeneratedEvents,
        {
          route,
          threadId: handle.threadId,
          message,
          requestContext: ctx.context,
        },
      );
      const ensuredThread = await ctx.copilotz.ops.getThreadById(
        handle.threadId,
      );
      await egress.deliver({
        route,
        callback: ctx.callback,
        context: ctx.context,
        handle: loggedHandle,
        thread: ensuredThread,
        message,
        copilotz: ctx.copilotz,
      });
    };

    await runWithSchema(envelopeSchema, runDelivery);
  };

  if (egress.requestBound) {
    if (egress.requiresCallback && !ctx.callback) {
      throw {
        status: 400,
        message: `Egress channel "${route.egress}" requires a callback`,
      };
    }
    if (envelopes.length !== 1) {
      throw {
        status: 400,
        message:
          `Request-bound egress channel "${route.egress}" supports exactly one message per request`,
      };
    }

    await deliverEnvelope(envelopes[0]);
    return {
      status: ingressResult.status ?? 200,
      data: ingressResult.response ?? { status: "ok" },
    };
  }

  for (const envelope of envelopes) {
    Promise.resolve()
      .then(() => deliverEnvelope(envelope))
      .catch((error) => {
        console.error("[channels] Detached egress delivery failed:", error);
      });
  }

  return {
    status: ingressResult.status ?? ingress.detachedResponseStatus ?? 200,
    data: ingressResult.response ?? {
      status: "accepted",
      accepted: envelopes.length,
      route,
    },
  };
}

function applyThreadMetadataPatch(envelope: IngressEnvelope) {
  const baseMessage = envelope.message;
  const mergedMetadata = mergeThreadMetadata(
    baseMessage.thread?.metadata,
    envelope.threadMetadataPatch,
  );
  return {
    ...baseMessage,
    thread: {
      ...(baseMessage.thread ?? {}),
      metadata: getSerializableThreadMetadata(mergedMetadata),
    },
  };
}

async function resolveThreadForMessage(
  copilotz: Copilotz,
  message: IngressEnvelope["message"],
) {
  const threadId = message.thread?.id;
  if (typeof threadId === "string" && threadId.length > 0) {
    return await copilotz.ops.getThreadById(threadId);
  }

  const externalId = message.thread?.externalId;
  if (typeof externalId === "string" && externalId.length > 0) {
    return await copilotz.ops.getThreadByExternalId(externalId);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// withApp
// ---------------------------------------------------------------------------

const APP_KEY = Symbol.for("copilotz.app");

/** Attaches the framework-independent app facade to a Copilotz instance. */
export function withApp<T extends Copilotz>(
  copilotz: T,
  options: WithAppOptions = {},
): T & { app: CopilotzApp } {
  const existing = (copilotz as any)[APP_KEY];
  if (existing) return copilotz as T & { app: CopilotzApp };

  const handlers = {
    threads: createThreadHandlers(copilotz),
    messages: createMessageHandlers(copilotz),
    collections: createCollectionHandlers(copilotz),
    assets: createAssetHandlers(copilotz),
    graph: createGraphHandlers(copilotz),
    events: createEventHandlers(copilotz),
    agents: {
      list: () => listPublicAgents(copilotz.config.agents ?? []),
    } as AgentHandlers,
    channels: createChannelHandlers(copilotz),
  };

  const routes = buildRoutes();

  // Register dynamic feature routes
  const features = (copilotz.config as any).features as
    | FeatureEntry[]
    | undefined;
  if (features?.length) {
    for (const feature of features) {
      const actions = feature.actions as Record<
        string,
        (request: Record<string, unknown>, copilotz: Copilotz) => unknown
      >;
      for (const [actionName, handler] of Object.entries(actions)) {
        const action = async (ctx: RouteContext) => {
          const result = await handler(
            {
              method: ctx.method,
              body: ctx.body,
              query: ctx.query,
              headers: ctx.headers,
              rawBody: ctx.rawBody,
              callback: ctx.callback,
              context: ctx.context,
              namespace: ctx.namespace,
              schema: ctx.schema,
            },
            ctx.copilotz,
          );
          const res = result as AppResponse | undefined;
          return {
            status: res?.status ?? 200,
            data: res?.data ?? result,
          };
        };
        routes.push({
          resource: "features",
          method: "*",
          pattern: [feature.name, actionName],
          action,
        });
        if (feature.name === "admin" && options.exposeAdminRoutes === true) {
          routes.push({
            resource: "admin",
            method: "*",
            pattern: [actionName],
            action,
          });
        }
      }
    }
  }

  const app: CopilotzApp = {
    ...handlers,
    handle: async (request: AppRequest): Promise<AppResponse> => {
      const {
        resource,
        method,
        path,
        query,
        body,
        headers,
        rawBody,
        callback,
        context,
      } = request;

      const matched = matchRoute(routes, resource, method, path);
      if (!matched) {
        throw {
          status: 404,
          message: `No route for ${method} /${resource}/${path.join("/")}`,
        };
      }

      const namespace = await resolveRequestNamespace(
        request,
        copilotz,
        options,
      );
      const schema = await resolveRequestSchema(request, copilotz, options);
      const ctx: RouteContext = {
        handlers,
        copilotz,
        query: (query ?? {}) as Record<string, unknown>,
        body: body,
        headers: headers ?? {},
        rawBody,
        callback,
        context,
        namespace,
        schema,
        appOptions: options,
        method,
      };

      return await runWithSchema(
        schema,
        () => matched.route.action(ctx, matched.params),
      );
    },

    resources: (): ResourceDescriptor[] => {
      const map = new Map<string, Set<string>>();
      for (const r of routes) {
        if (!map.has(r.resource)) map.set(r.resource, new Set());
        map.get(r.resource)!.add(r.method);
      }
      return [...map.entries()].map(([name, methods]) => ({
        name,
        methods: [...methods],
      }));
    },
  };

  Object.defineProperty(copilotz, APP_KEY, { value: true, enumerable: false });
  Object.defineProperty(copilotz, "app", { value: app, enumerable: true });

  return copilotz as T & { app: CopilotzApp };
}

function withGeneratedEventLogging(
  handle: RunHandle,
  logger: AppGeneratedEventLogger | undefined,
  context: AppGeneratedEventLogContext,
): RunHandle {
  if (!logger) return handle;

  return {
    ...handle,
    events: (async function* () {
      for await (const event of handle.events) {
        await logGeneratedEvent(logger, event, context);
        yield event;
      }
    })(),
  };
}

const DEFAULT_EXCLUDED_EVENT_TYPES = new Set(["TOKEN", "ASSET_CREATED"]);

async function logGeneratedEvent(
  logger: AppGeneratedEventLogger,
  event: unknown,
  context: AppGeneratedEventLogContext,
): Promise<void> {
  try {
    if (!shouldLogGeneratedEvent(logger, event)) return;

    const customLogger = typeof logger === "function"
      ? logger
      : typeof logger === "object" && logger !== null
      ? logger.logger
      : undefined;
    if (customLogger) {
      await customLogger(event, context);
      return;
    }

    if (logger === true || typeof logger === "object") {
      console.log(
        "[copilotz:app:event] " + JSON.stringify({
          type: getGeneratedEventType(event),
          threadId: context.threadId,
          route: context.route,
        }),
      );
    }
  } catch (error) {
    console.warn("[copilotz:app:event] Event logger failed:", error);
  }
}

function shouldLogGeneratedEvent(
  logger: AppGeneratedEventLogger,
  event: unknown,
): boolean {
  if (logger === false) return false;

  const options = typeof logger === "object" && logger !== null ? logger : {};
  const eventType = getGeneratedEventType(event);

  const hasExplicitEventTypes = options.eventTypes !== undefined &&
    options.eventTypes.length > 0;
  if (hasExplicitEventTypes && !options.eventTypes?.includes(eventType)) {
    return false;
  }
  if (!hasExplicitEventTypes && DEFAULT_EXCLUDED_EVENT_TYPES.has(eventType)) {
    return false;
  }
  if (options.excludeEventTypes?.includes(eventType)) return false;

  return true;
}

function getGeneratedEventType(event: unknown): string {
  return typeof event === "object" && event !== null && "type" in event
    ? String((event as { type?: unknown }).type)
    : "unknown";
}

async function runWithSchema<T>(
  schema: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!schema || schema === "public") return await fn();
  return await withSchema(schema, fn);
}

async function resolveRequestNamespace(
  request: AppRequest,
  copilotz: Copilotz,
  options: WithAppOptions,
): Promise<string | undefined> {
  const contextNamespace = request.context?.namespace;
  if (typeof contextNamespace === "string" && contextNamespace.trim()) {
    return contextNamespace;
  }

  const resolved = await options.resolveNamespace?.(request);
  if (typeof resolved === "string" && resolved.trim()) return resolved;

  const configNamespace = copilotz.config.namespace;
  return typeof configNamespace === "string" && configNamespace.trim()
    ? configNamespace
    : undefined;
}

async function resolveRequestSchema(
  request: AppRequest,
  copilotz: Copilotz,
  options: WithAppOptions,
): Promise<string | undefined> {
  const contextSchema = request.context?.schema;
  if (typeof contextSchema === "string" && contextSchema.trim()) {
    return contextSchema;
  }

  const resolved = await options.resolveSchema?.(request);
  if (typeof resolved === "string" && resolved.trim()) return resolved;

  const configSchema = copilotz.config.dbConfig?.defaultSchema;
  return typeof configSchema === "string" && configSchema.trim()
    ? configSchema
    : undefined;
}
