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
import { listPublicAgents } from "@/utils/list-agents.ts";
import type { FeatureEntry, ChannelEntry } from "@/runtime/loaders/resources.ts";
import type { MessageHistoryPageInfo } from "@/database/operations/index.ts";

import { createThreadHandlers } from "./threads.ts";
import type { ThreadHandlers } from "./threads.ts";
import { createMessageHandlers } from "./messages.ts";
import type { MessageHandlers } from "./messages.ts";
import { createCollectionHandlers } from "./collections.ts";
import type { CollectionHandlers } from "./collections.ts";
import { createAssetHandlers } from "./assets.ts";
import type { AssetHandlers } from "./assets.ts";
import { createParticipantHandlers } from "./participants.ts";
import type { ParticipantHandlers } from "./participants.ts";
import { createGraphHandlers } from "./graph.ts";
import type { GraphHandlers } from "./graph.ts";
import { createEventHandlers } from "./events.ts";
import type { EventHandlers } from "./events.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AppRequest {
  resource: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string[];
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
  callback?: (event: unknown) => void;
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
  pageInfo?: MessageHistoryPageInfo;
}

export interface AgentHandlers {
  list: () => unknown[];
}

export interface ChannelContext {
  method: string;
  headers: Record<string, string>;
  body: unknown;
  callback?: (event: unknown) => void;
}

export type ChannelHandler = (ctx: ChannelContext) => Promise<unknown>;

export type ChannelHandlers = Record<string, ChannelHandler>;

export interface ResourceDescriptor {
  name: string;
  methods: string[];
}

export interface CopilotzApp {
  threads: ThreadHandlers;
  messages: MessageHandlers;
  collections: CollectionHandlers;
  assets: AssetHandlers;
  participants: ParticipantHandlers;
  graph: GraphHandlers;
  events: EventHandlers;
  agents: AgentHandlers;
  channels: ChannelHandlers;
  handle(request: AppRequest): Promise<AppResponse>;
  resources(): ResourceDescriptor[];
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
    participants: ParticipantHandlers;
    graph: GraphHandlers;
    events: EventHandlers;
    agents: AgentHandlers;
    channels: ChannelHandlers;
  };
  copilotz: Copilotz;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string>;
  callback?: (event: unknown) => void;
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
        params[route.pattern[i].slice(1)] = path[i];
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
      resource: "agents", method: "GET", pattern: [],
      action: async (ctx) => ({ status: 200, data: ctx.handlers.agents.list() }),
    },

    // ---- assets ----
    {
      resource: "assets", method: "GET", pattern: [":id"],
      action: async (ctx, p) => {
        const format = ctx.query.format as string || "dataUrl";
        if (format === "base64") {
          const result = await ctx.handlers.assets.getBase64(p.id);
          return { status: 200, data: { assetId: p.id, ...result } };
        }
        const result = await ctx.handlers.assets.getDataUrl(p.id);
        return { status: 200, data: { assetId: p.id, ...result } };
      },
    },

    // ---- participants ----
    {
      resource: "participants", method: "GET", pattern: [":id"],
      action: async (ctx, p) => ({
        status: 200,
        data: await ctx.handlers.participants.get(p.id),
      }),
    },
    {
      resource: "participants", method: "PUT", pattern: [":id"],
      action: async (ctx, p) => {
        const body = ctx.body as Record<string, unknown>;
        const replaceMemories = ctx.query.replaceMemories;
        return {
          status: 200,
          data: await ctx.handlers.participants.update(p.id, body, {
            replaceKeys: replaceMemories === "true" || replaceMemories === true
              ? ["memories"]
              : [],
            participantType: "human",
          }),
        };
      },
    },

    // ---- threads ----
    {
      resource: "threads", method: "GET", pattern: [],
      action: async (ctx) => {
        const participantId = ctx.query.participantId as string;
        if (!participantId) throw { status: 400, message: "participantId query parameter is required" };
        return {
          status: 200,
          data: await ctx.handlers.threads.list(participantId, {
            status: asEnum(ctx.query.status as string, ["active", "archived", "all"]),
            limit: asNumber(ctx.query.limit),
            offset: asNumber(ctx.query.offset),
            order: asEnum(ctx.query.order as string, ["asc", "desc"]),
          }),
        };
      },
    },
    {
      resource: "threads", method: "POST", pattern: [],
      action: async (ctx) => {
        const body = ctx.body as Record<string, unknown>;
        return {
          status: 201,
          data: await ctx.handlers.threads.findOrCreate(
            body.id as string | undefined,
            body as Parameters<ThreadHandlers["findOrCreate"]>[1],
          ),
        };
      },
    },
    {
      resource: "threads", method: "GET", pattern: [":id"],
      action: async (ctx, p) => {
        const thread = await ctx.handlers.threads.getById(p.id);
        if (!thread) throw { status: 404, message: "Thread not found" };
        return { status: 200, data: thread };
      },
    },
    {
      resource: "threads", method: "PATCH", pattern: [":id"],
      action: async (ctx, p) => {
        const updated = await ctx.handlers.threads.update(p.id, ctx.body as Record<string, unknown>);
        if (!updated) throw { status: 404, message: "Thread not found" };
        return { status: 200, data: updated };
      },
    },
    {
      resource: "threads", method: "DELETE", pattern: [":id"],
      action: async (ctx, p) => {
        await ctx.handlers.threads.delete(p.id);
        return { status: 204 };
      },
    },
    {
      resource: "threads", method: "POST", pattern: [":id"],
      action: async (ctx, p) => {
        const body = ctx.body as Record<string, unknown>;
        return {
          status: 200,
          data: await (ctx.handlers.threads as any).archive(p.id, (body.summary as string) ?? ""),
        };
      },
    },

    // ---- threads/:id/messages ----
    {
      resource: "threads", method: "GET", pattern: [":id", "messages"],
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
      resource: "threads", method: "DELETE", pattern: [":id", "messages"],
      action: async (ctx, p) => {
        await ctx.handlers.messages.deleteForThread(p.id);
        return { status: 204 };
      },
    },

    // ---- threads/:id/events ----
    {
      resource: "threads", method: "GET", pattern: [":id", "events"],
      action: async (ctx, p) => {
        const h = ctx.handlers.events;
        if (ctx.query.status === "processing") {
          return { status: 200, data: await h.getProcessing(p.id) };
        }
        return { status: 200, data: await h.getNextPending(p.id) };
      },
    },
    {
      resource: "threads", method: "POST", pattern: [":id", "events"],
      action: async (ctx, p) => ({
        status: 201,
        data: await ctx.handlers.events.enqueue(p.id, ctx.body as any),
      }),
    },

    // ---- collections ----
    {
      resource: "collections", method: "GET", pattern: [],
      action: async (ctx) => ({
        status: 200,
        data: ctx.handlers.collections.listCollections(),
      }),
    },
    {
      resource: "collections", method: "GET", pattern: [":collection"],
      action: async (ctx, p) => {
        const q = ctx.query.q as string | undefined;
        const namespace = ctx.query.namespace as string | undefined;
        if (q) {
          return {
            status: 200,
            data: await ctx.handlers.collections.search(p.collection, q, {
              namespace,
              limit: asNumber(ctx.query.limit),
            }),
          };
        }
        return {
          status: 200,
          data: await ctx.handlers.collections.list(p.collection, {
            namespace,
            filter: parseJsonParam(ctx.query.filter),
            limit: asNumber(ctx.query.limit),
            offset: asNumber(ctx.query.offset),
            sort: parseSortParam(ctx.query.sort),
          }),
        };
      },
    },
    {
      resource: "collections", method: "POST", pattern: [":collection"],
      action: async (ctx, p) => ({
        status: 201,
        data: await ctx.handlers.collections.create(
          p.collection,
          ctx.body as Record<string, unknown>,
          { namespace: ctx.query.namespace as string | undefined },
        ),
      }),
    },
    {
      resource: "collections", method: "GET", pattern: [":collection", ":id"],
      action: async (ctx, p) => {
        const result = await ctx.handlers.collections.getById(p.collection, p.id, {
          namespace: ctx.query.namespace as string | undefined,
        });
        if (!result) throw { status: 404, message: `${p.collection} not found` };
        return { status: 200, data: result };
      },
    },
    {
      resource: "collections", method: "PUT", pattern: [":collection", ":id"],
      action: async (ctx, p) => ({
        status: 200,
        data: await ctx.handlers.collections.update(
          p.collection, p.id,
          ctx.body as Record<string, unknown>,
          { namespace: ctx.query.namespace as string | undefined },
        ),
      }),
    },
    {
      resource: "collections", method: "DELETE", pattern: [":collection", ":id"],
      action: async (ctx, p) => {
        await ctx.handlers.collections.delete(p.collection, p.id, {
          namespace: ctx.query.namespace as string | undefined,
        });
        return { status: 204 };
      },
    },

    // ---- graph ----
    {
      resource: "graph", method: "POST", pattern: ["search"],
      action: async (ctx) => ({
        status: 200,
        data: await ctx.handlers.graph.search(ctx.body as any),
      }),
    },
    {
      resource: "graph", method: "GET", pattern: ["nodes", ":id"],
      action: async (ctx, p) => {
        const node = await ctx.handlers.graph.getNodeById(p.id);
        if (!node) throw { status: 404, message: "Node not found" };
        return { status: 200, data: node };
      },
    },
    {
      resource: "graph", method: "PATCH", pattern: ["nodes", ":id"],
      action: async (ctx, p) => {
        const node = await ctx.handlers.graph.updateNode(p.id, ctx.body as any);
        if (!node) throw { status: 404, message: "Node not found" };
        return { status: 200, data: node };
      },
    },
    {
      resource: "graph", method: "DELETE", pattern: ["nodes", ":id"],
      action: async (ctx, p) => {
        await ctx.handlers.graph.deleteNode(p.id);
        return { status: 204 };
      },
    },
    {
      resource: "graph", method: "GET", pattern: ["nodes", ":id", "edges"],
      action: async (ctx, p) => {
        const direction = asEnum(ctx.query.direction as string, ["in", "out", "both"]);
        const types = Array.isArray(ctx.query.type)
          ? ctx.query.type as string[]
          : ctx.query.type ? [ctx.query.type as string] : undefined;
        return {
          status: 200,
          data: await ctx.handlers.graph.getEdges(p.id, { direction, types }),
        };
      },
    },
    {
      resource: "graph", method: "GET", pattern: ["nodes", ":id", "related"],
      action: async (ctx, p) => ({
        status: 200,
        data: await ctx.handlers.graph.findRelated(p.id, {
          depth: asNumber(ctx.query.depth),
        }),
      }),
    },
    {
      resource: "graph", method: "GET", pattern: ["namespaces", ":namespace", "nodes"],
      action: async (ctx, p) => ({
        status: 200,
        data: await ctx.handlers.graph.listNodes(p.namespace, {
          type: ctx.query.type as string | undefined,
        }),
      }),
    },

    // ---- channels ----
    {
      resource: "channels", method: "POST", pattern: [":type"],
      action: async (ctx, p) => {
        const handler = ctx.handlers.channels[p.type];
        if (!handler) throw { status: 404, message: `Unknown channel type: ${p.type}` };
        const result = await handler({
          method: ctx.method,
          headers: ctx.headers,
          body: ctx.body,
          callback: ctx.callback,
        });
        return { status: 200, data: result };
      },
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

function asEnum<T extends string>(val: string | undefined, allowed: T[]): T | undefined {
  if (!val) return undefined;
  return allowed.includes(val as T) ? (val as T) : undefined;
}

/** Parse a JSON-encoded query param into an object, returning undefined on failure. */
function parseJsonParam(val: unknown): Record<string, unknown> | undefined {
  if (!val || typeof val !== "string") return undefined;
  try {
    const parsed = JSON.parse(val);
    return typeof parsed === "object" && parsed && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Parse a sort query param like "name:asc,createdAt:desc" into a sort array. */
function parseSortParam(val: unknown): Array<{ field: string; direction: "asc" | "desc" }> | undefined {
  if (!val || typeof val !== "string") return undefined;
  const parts = val.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  return parts.map((part) => {
    const [field, dir] = part.split(":");
    return { field, direction: dir === "desc" ? "desc" as const : "asc" as const };
  });
}

// ---------------------------------------------------------------------------
// Channel handler builder
// ---------------------------------------------------------------------------

function buildChannelHandlers(copilotz: Copilotz): ChannelHandlers {
  const channels = (copilotz.config as any).channels as ChannelEntry[] | undefined;
  const handlers: ChannelHandlers = {};
  if (channels?.length) {
    for (const channel of channels) {
      handlers[channel.name] = (ctx: ChannelContext) => channel.handler(ctx, copilotz);
    }
  }
  return handlers;
}

// ---------------------------------------------------------------------------
// withApp
// ---------------------------------------------------------------------------

const APP_KEY = Symbol.for("copilotz.app");

export function withApp<T extends Copilotz>(copilotz: T): T & { app: CopilotzApp } {
  const existing = (copilotz as any)[APP_KEY];
  if (existing) return copilotz as T & { app: CopilotzApp };

  const handlers = {
    threads: createThreadHandlers(copilotz),
    messages: createMessageHandlers(copilotz),
    collections: createCollectionHandlers(copilotz),
    assets: createAssetHandlers(copilotz),
    participants: createParticipantHandlers(copilotz),
    graph: createGraphHandlers(copilotz),
    events: createEventHandlers(copilotz),
    agents: {
      list: () => listPublicAgents(copilotz.config.agents ?? []),
    } as AgentHandlers,
    channels: buildChannelHandlers(copilotz),
  };

  const routes = buildRoutes();

  // Register dynamic feature routes
  const features = (copilotz.config as any).features as FeatureEntry[] | undefined;
  if (features?.length) {
    for (const feature of features) {
      for (const [actionName, handler] of Object.entries(feature.actions)) {
        routes.push({
          resource: "features",
          method: "*",
          pattern: [feature.name, actionName],
          action: async (ctx) => {
            const result = await handler(
              {
                method: ctx.method,
                body: ctx.body,
                query: ctx.query,
                headers: ctx.headers,
                callback: ctx.callback,
              },
              ctx.copilotz,
            );
            const res = result as AppResponse | undefined;
            return {
              status: res?.status ?? 200,
              data: res?.data ?? result,
            };
          },
        });
      }
    }
  }

  const app: CopilotzApp = {
    ...handlers,
    handle: async (request: AppRequest): Promise<AppResponse> => {
      const { resource, method, path, query, body, headers, callback } = request;

      const matched = matchRoute(routes, resource, method, path);
      if (!matched) {
        throw { status: 404, message: `No route for ${method} /${resource}/${path.join("/")}` };
      }

      const ctx: RouteContext = {
        handlers,
        copilotz,
        query: (query ?? {}) as Record<string, unknown>,
        body: body,
        headers: headers ?? {},
        callback,
        method,
      };

      return matched.route.action(ctx, matched.params);
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
