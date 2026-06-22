import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { withApp } from "./app.ts";
import type { AppRequest } from "./app.ts";

// ---------------------------------------------------------------------------
// Mock Copilotz — satisfies the shape each handler factory reads
// ---------------------------------------------------------------------------

function createMockCopilotz() {
  const calls: { method: string; args: unknown[] }[] = [];
  const deliveries: {
    route: { ingress: string; egress: string };
    threadId?: string;
    message: unknown;
    events: string[];
    context?: unknown;
  }[] = [];

  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const mockOps = {
    getThreadsForParticipant: async (pid: string, opts?: unknown) => {
      record("getThreadsForParticipant", pid, opts);
      return [{ id: "t-1", participantId: pid }];
    },
    getThreadById: async (id: string) => {
      record("getThreadById", id);
      if (id === "not-found") return undefined;
      if (id === "zd-thread") {
        return {
          id,
          name: "Zendesk Thread",
          metadata: {
            system: {
              channels: {
                zendesk: { conversationId: "conv-1" },
              },
            },
          },
        };
      }
      if (id === "edit-thread") {
        return {
          id,
          name: "Edit Thread",
          namespace: "tenant-test",
          metadata: {},
        };
      }
      return { id, name: "Test Thread" };
    },
    getThreadByExternalId: async (eid: string) => {
      record("getThreadByExternalId", eid);
      return { id: "t-ext", externalId: eid };
    },
    findOrCreateThread: async (id: string | undefined, data: unknown) => {
      record("findOrCreateThread", id, data);
      return { id: id ?? "new-thread", ...(data as object) };
    },
    updateThread: async (id: string, updates: unknown) => {
      record("updateThread", id, updates);
      return { id, ...(updates as object) };
    },
    deleteThread: async (id: string) => {
      record("deleteThread", id);
    },
    archiveThread: async (id: string, summary: string) => {
      record("archiveThread", id, summary);
      return { id, status: "archived", summary };
    },
    getMessagesForThread: async (tid: string, opts?: unknown) => {
      record("getMessagesForThread", tid, opts);
      return [];
    },
    getMessageHistory: async (tid: string, uid: string, limit?: number) => {
      record("getMessageHistory", tid, uid, limit);
      return [];
    },
    getMessageHistoryFromGraph: async (tid: string, limit?: number) => {
      record("getMessageHistoryFromGraph", tid, limit);
      if (tid === "edit-thread") {
        return [{
          id: "msg-user",
          threadId: tid,
          senderId: "user-1",
          senderType: "user",
          content: "old content",
          metadata: {},
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }];
      }
      return [];
    },
    getMessageHistoryPageFromGraph: async (tid: string, opts?: unknown) => {
      record("getMessageHistoryPageFromGraph", tid, opts);
      return {
        data: [],
        pageInfo: {
          hasMoreBefore: false,
          oldestMessageId: null,
          newestMessageId: null,
        },
      };
    },
    deleteMessagesForThread: async (tid: string) => {
      record("deleteMessagesForThread", tid);
    },
    createMessage: async (message: Record<string, unknown>) => {
      record("createMessage", message);
      return {
        id: "msg-user-edit",
        ...message,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    },
    getParticipantNode: async (eid: string, _ns?: string | null) => {
      record("getParticipantNode", eid);
      return eid === "not-found"
        ? undefined
        : { id: eid, data: { metadata: { name: "Alice" } } };
    },
    upsertParticipantNode: async (
      eid: string,
      type: string,
      ns: string | null,
      data: unknown,
    ) => {
      record("upsertParticipantNode", eid, type, ns, data);
    },
    addToQueue: async (tid: string, event: unknown) => {
      record("addToQueue", tid, event);
      return { id: "q-1", threadId: tid };
    },
    getProcessingQueueItem: async (tid: string) => {
      record("getProcessingQueueItem", tid);
      return { id: "q-p", threadId: tid, status: "processing" };
    },
    getThreadActivity: async (tid: string, options?: unknown) => {
      record("getThreadActivity", tid, options);
      return {
        threadId: tid,
        status: "running",
        activeCount: 1,
        lastFailure: null,
        updatedAt: new Date().toISOString(),
      };
    },
    getNextPendingQueueItem: async (tid: string) => {
      record("getNextPendingQueueItem", tid);
      return { id: "q-n", threadId: tid, status: "pending" };
    },
    updateQueueItemStatus: async (eid: string, status: string) => {
      record("updateQueueItemStatus", eid, status);
    },
    query: async (_sql: string, _params?: unknown[]) => {
      record("query", _sql);
      return { rows: [] };
    },
    getNodeById: async (id: string) => {
      record("getNodeById", id);
      return { id, type: "test", namespace: "ns" };
    },
    getNodesByNamespace: async (ns: string, type?: string) => {
      record("getNodesByNamespace", ns, type);
      return [{ id: "n-1", namespace: ns }];
    },
    getEdgesForNode: async (nid: string, opts?: unknown) => {
      record("getEdgesForNode", nid, opts);
      return [];
    },
    traverseGraph: async (nid: string, opts?: unknown) => {
      record("traverseGraph", nid, opts);
      return { nodes: [], edges: [] };
    },
    findRelatedNodes: async (nid: string, opts?: unknown) => {
      record("findRelatedNodes", nid, opts);
      return [];
    },
    searchNodes: async (opts: unknown) => {
      record("searchNodes", opts);
      return [{ id: "result-1" }];
    },
    updateNode: async (id: string, updates: unknown) => {
      record("updateNode", id, updates);
      return { id, ...(updates as object) };
    },
    deleteNode: async (id: string) => {
      record("deleteNode", id);
    },
    mutate: {
      graph: {
        updateNode: async (
          id: string,
          updates: unknown,
          options: unknown,
        ) => {
          record("mutate.graph.updateNode", id, updates, options);
          return { id, ...(updates as object) };
        },
        deleteNode: async (id: string, options: unknown) => {
          record("mutate.graph.deleteNode", id, options);
        },
      },
    },
  };

  const mockAssets = {
    getBase64: async (ref: string, opts?: unknown) => {
      record("assets.getBase64", ref, opts);
      return { base64: "AQID", mime: "image/png" };
    },
    getDataUrl: async (ref: string, opts?: unknown) => {
      record("assets.getDataUrl", ref, opts);
      return "data:image/png;base64,AQID";
    },
  };

  const mockCollections = {
    getCollectionNames: () => ["customers", "orders", "participant"],
    hasCollection: (name: string) =>
      ["customers", "orders", "participant"].includes(name),
    withNamespace: () => ({
      participant: {
        findOne: async (filter: Record<string, unknown>) => {
          record("collections.participant.findOne", filter);
          if (filter.externalId === "not-found") return null;
          return {
            id: "participant-1",
            externalId: filter.externalId,
            participantType: "human",
            name: "Alice",
            metadata: { name: "Alice" },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
        },
        update: async (
          filter: Record<string, unknown>,
          data: Record<string, unknown>,
        ) => {
          record("collections.participant.update", filter, data);
          return {
            id: "participant-1",
            externalId: filter.externalId,
            participantType: "human",
            ...data,
          };
        },
      },
    }),
  };

  const copilotz = {
    ops: mockOps,
    assets: mockAssets,
    collections: mockCollections,
    config: {
      namespace: "tenant-test",
      collections: [
        { name: "customers", keys: [{ property: "id" }] },
        { name: "orders", keys: [{ property: "id" }] },
        { name: "participant", keys: [{ property: "externalId" }] },
      ],
      agents: [
        {
          id: "agent-1",
          name: "Helper",
          description: "A test agent",
          public: true,
        },
      ],
      features: [
        {
          name: "echo",
          actions: {
            ping: async (req: any) => ({
              status: 200,
              data: {
                pong: true,
                received: req.body,
                context: req.context ?? null,
                namespace: req.namespace ?? null,
                schema: req.schema ?? null,
              },
            }),
          },
        },
        {
          name: "admin",
          actions: {
            overview: async (_req: any, _c: any) => ({
              status: 200,
              data: { totalThreads: 42 },
            }),
            threads: async (_req: any, _c: any) => ({
              status: 200,
              data: [],
            }),
            activity: async (_req: any, _c: any) => ({
              status: 200,
              data: [],
            }),
          },
        },
      ],
      channels: [
        {
          name: "web",
          ingress: {
            detachedResponseStatus: 202,
            async handle(ctx: any) {
              return {
                messages: [{ message: ctx.body }],
              };
            },
          },
        },
        {
          name: "web",
          egress: {
            requestBound: true,
            requiresCallback: true,
            async deliver(ctx: any) {
              if (!ctx.callback) {
                throw {
                  status: 400,
                  message: "Web egress requires a callback for streaming",
                };
              }
              for await (const event of ctx.handle.events) {
                ctx.callback(event);
              }
            },
          },
        },
        {
          name: "zendesk",
          egress: {
            async deliver(ctx: any) {
              const events: string[] = [];
              for await (const event of ctx.handle.events) {
                events.push(event.type);
              }
              deliveries.push({
                route: ctx.route,
                threadId: ctx.thread?.id,
                message: ctx.message,
                events,
                context: ctx.context ?? null,
              });
              record("zendesk.deliver", ctx.route, ctx.thread, ctx.message);
            },
          },
        },
        {
          name: "inspect",
          ingress: {
            async handle(ctx: any) {
              return {
                status: 200,
                response: { context: ctx.context ?? null },
                messages: [],
              };
            },
          },
          egress: {
            async deliver() {
              // no-op
            },
          },
        },
      ],
    },
    run: async (msg: unknown, options?: unknown) => {
      record("run", msg, options);
      const threadId = typeof msg === "object" && msg !== null &&
          "thread" in msg &&
          typeof (msg as { thread?: { id?: unknown } }).thread?.id === "string"
        ? (msg as { thread: { id: string } }).thread.id
        : "run-thread";
      const content = typeof msg === "object" && msg !== null &&
          "content" in msg
        ? (msg as { content?: unknown }).content
        : undefined;
      return {
        threadId,
        events: (async function* () {
          yield { type: "TOKEN", payload: { text: "hello" } };
          if (content === "include excluded") {
            yield {
              type: "ASSET_CREATED",
              payload: { assetId: "asset-1" },
            };
          }
          yield {
            type: "NEW_MESSAGE",
            payload: {
              sender: { type: "agent" },
              content: "hello world",
            },
          };
        })(),
      };
    },
    schema: {},
  };

  return { copilotz, calls, deliveries };
}

// ---------------------------------------------------------------------------
// HTTP helper — in-memory request adapter that pipes to handle()
// ---------------------------------------------------------------------------

function createServer(copilotz: ReturnType<typeof withApp>) {
  const request = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const req = input instanceof Request
      ? input
      : new Request(String(input), init);
    const url = new URL(req.url);
    const segments = url.pathname.replace(/^\/v1\//, "").split("/").filter(
      Boolean,
    );
    const [resource, ...path] = segments;

    if (!resource) {
      return Response.json({ error: "Resource required" }, { status: 400 });
    }

    let body: unknown;
    let rawBody: Uint8Array | undefined;
    if (req.method !== "GET" && req.method !== "DELETE") {
      const rawText = await req.text();
      rawBody = new TextEncoder().encode(rawText);
      if (rawText) {
        try {
          body = JSON.parse(rawText);
        } catch {
          body = rawText;
        }
      }
    }

    const appReq: AppRequest = {
      resource,
      method: req.method as AppRequest["method"],
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: Object.fromEntries(req.headers),
      rawBody,
    };

    // SSE callback for request-bound web egress
    if (resource === "channels" && path.length === 1 && path[0] === "web") {
      let streamBody = "";

      appReq.callback = (event: unknown) => {
        const e = event as { type?: string };
        streamBody += `event: ${e.type ?? "message"}\ndata: ${
          JSON.stringify(event)
        }\n\n`;
      };
      try {
        await copilotz.app.handle(appReq);
        return new Response(streamBody, {
          headers: { "content-type": "text/event-stream" },
        });
      } catch (err: any) {
        const status = err?.status ?? 500;
        return Response.json(
          { error: err?.message ?? "Internal error" },
          { status },
        );
      }
    }

    try {
      const result = await copilotz.app.handle(appReq);
      if (result.status === 204) return new Response(null, { status: 204 });
      // Uniform envelope: HTTP body is always `{ data, pageInfo? }`.
      const body: Record<string, unknown> = { data: result.data };
      if (result.pageInfo !== undefined) body.pageInfo = result.pageInfo;
      return Response.json(body, { status: result.status });
    } catch (err: any) {
      const status = err?.status ?? 500;
      return Response.json(
        { error: err?.message ?? "Internal error" },
        { status },
      );
    }
  };

  return {
    server: { shutdown: async () => {} },
    base: "http://localhost/v1",
    request,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for async condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("withApp — handle() routes and Deno.serve integration", async (t) => {
  const { copilotz, calls, deliveries } = createMockCopilotz();
  // deno-lint-ignore no-explicit-any
  const extended = withApp(copilotz as any);
  const { server, base, request } = createServer(extended);
  const fetch = request;

  try {
    // -- agents --
    await t.step("GET /agents returns agent list", async () => {
      const res = await fetch(`${base}/agents`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(Array.isArray(data), true);
      assertEquals(data.length, 1);
      assertEquals(data[0].name, "Helper");
    });

    // -- threads --
    await t.step("GET /threads?participantId=... returns threads", async () => {
      const res = await fetch(`${base}/threads?participantId=p-1`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(Array.isArray(data), true);
      assertEquals(data[0].participantId, "p-1");
    });

    await t.step("GET /threads without participantId returns 400", async () => {
      const res = await fetch(`${base}/threads`);
      assertEquals(res.status, 400);
      await res.body?.cancel();
    });

    await t.step("POST /threads creates a thread", async () => {
      const res = await fetch(`${base}/threads`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "New Thread" }),
      });
      assertEquals(res.status, 201);
      const { data } = await res.json();
      assertEquals(data.name, "New Thread");
    });

    await t.step(
      "POST /threads uses request namespace over body namespace",
      async () => {
        const { copilotz, calls } = createMockCopilotz();
        withApp(copilotz as any);

        await (copilotz as any).app.handle({
          resource: "threads",
          method: "POST",
          path: [],
          body: { name: "Tenant Thread", namespace: "body-namespace" },
          context: { namespace: "request-namespace" },
        });

        const call = calls.find((entry) =>
          entry.method === "findOrCreateThread"
        );
        assertExists(call);
        assertEquals(
          (call.args[1] as { namespace?: string }).namespace,
          "request-namespace",
        );
      },
    );

    await t.step(
      "GET /assets/:id uses request namespace for bare asset ids",
      async () => {
        const { copilotz, calls } = createMockCopilotz();
        withApp(copilotz as any);

        const result = await (copilotz as any).app.handle({
          resource: "assets",
          method: "GET",
          path: ["asset-1"],
          context: { namespace: "tenant-assets" },
        });

        assertEquals(result.status, 200);
        const call = calls.find((entry) =>
          entry.method === "assets.getDataUrl"
        );
        assertExists(call);
        assertEquals(call.args[0], "asset://asset-1");
        assertEquals(call.args[1], { namespace: "tenant-assets" });
      },
    );

    await t.step(
      "GET /assets/:id keeps explicit asset ref namespace over request namespace",
      async () => {
        const { copilotz, calls } = createMockCopilotz();
        withApp(copilotz as any);

        const result = await (copilotz as any).app.handle({
          resource: "assets",
          method: "GET",
          path: ["asset://ref-tenant/asset-1"],
          context: { namespace: "request-tenant" },
        });

        assertEquals(result.status, 200);
        const call = calls.find((entry) =>
          entry.method === "assets.getDataUrl"
        );
        assertExists(call);
        assertEquals(call.args[0], "asset://ref-tenant/asset-1");
        assertEquals(call.args[1], { namespace: "ref-tenant" });
      },
    );

    await t.step("GET /threads/:id returns a thread", async () => {
      const res = await fetch(`${base}/threads/t-100`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.id, "t-100");
    });

    await t.step("GET /threads/not-found returns 404", async () => {
      const res = await fetch(`${base}/threads/not-found`);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });

    await t.step("PATCH /threads/:id updates a thread", async () => {
      const res = await fetch(`${base}/threads/t-100`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Updated" }),
      });
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.name, "Updated");
    });

    await t.step("DELETE /threads/:id returns 204", async () => {
      const res = await fetch(`${base}/threads/t-100`, { method: "DELETE" });
      assertEquals(res.status, 204);
      await res.body?.cancel();
    });

    // -- threads/:id/messages --
    await t.step("GET /threads/:id/messages returns messages", async () => {
      const res = await fetch(`${base}/threads/t-100/messages?limit=10`);
      assertEquals(res.status, 200);
      const body = await res.json();
      assertExists(body);
      // Uniform envelope: `{ data, pageInfo }` for paginated endpoints.
      assertEquals(Array.isArray(body.data), true);
      assertExists(body.pageInfo);
    });

    await t.step("DELETE /threads/:id/messages returns 204", async () => {
      const res = await fetch(`${base}/threads/t-100/messages`, {
        method: "DELETE",
      });
      assertEquals(res.status, 204);
      await res.body?.cancel();
    });

    await t.step(
      "POST /threads/:id/messages/:messageId/edit creates message revision",
      async () => {
        const res = await fetch(
          `${base}/threads/edit-thread/messages/msg-user/edit`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ content: "edited content" }),
          },
        );
        assertEquals(res.status, 201);
        const { data } = await res.json();
        assertEquals(data.message.id, "msg-user-edit");
        assertEquals(data.message.content, "edited content");
        assertEquals(data.rootMessageId, "msg-user");
        assertEquals(data.revisionIndex, 1);
      },
    );

    // -- threads/:id/events --
    await t.step("GET /threads/:id/events returns pending event", async () => {
      const res = await fetch(`${base}/threads/t-100/events`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.status, "pending");
    });

    await t.step(
      "GET /threads/:id/events?status=processing returns processing event",
      async () => {
        const res = await fetch(
          `${base}/threads/t-100/events?status=processing`,
        );
        assertEquals(res.status, 200);
        const { data } = await res.json();
        assertEquals(data.status, "processing");
      },
    );

    await t.step(
      "GET /threads/:id/activity returns thread activity",
      async () => {
        const res = await fetch(
          `${base}/threads/t-100/activity?includeEvents=true&minPriority=0`,
        );
        assertEquals(res.status, 200);
        const { data } = await res.json();
        assertEquals(data.threadId, "t-100");
        assertEquals(data.status, "running");
        assertEquals(data.activeCount, 1);
      },
    );

    await t.step("POST /threads/:id/events enqueues event", async () => {
      const res = await fetch(`${base}/threads/t-100/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "MESSAGE", data: { content: "hi" } }),
      });
      assertEquals(res.status, 201);
    });

    // -- participant via collections --
    await t.step(
      "GET /collections/participant/:id returns participant",
      async () => {
        const res = await fetch(
          `${base}/collections/participant/user-1`,
        );
        assertEquals(res.status, 200);
        const { data } = await res.json();
        assertEquals(data.name, "Alice");
      },
    );

    await t.step(
      "PUT /collections/participant/:id updates participant",
      async () => {
        const res = await fetch(
          `${base}/collections/participant/user-1`,
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ age: 30 }),
          },
        );
        assertEquals(res.status, 200);
      },
    );

    await t.step("GET /participants/:id is removed", async () => {
      const res = await fetch(`${base}/participants/user-1`);
      assertEquals(res.status, 404);
    });

    // -- collections --
    await t.step("GET /collections returns collection names", async () => {
      const res = await fetch(`${base}/collections`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data, ["customers", "orders", "participant"]);
    });

    // -- admin (via features) --
    await t.step("GET /features/admin/overview returns overview", async () => {
      const res = await fetch(`${base}/features/admin/overview`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.totalThreads, 42);
    });

    await t.step(
      "GET /features/admin/threads returns thread list",
      async () => {
        const res = await fetch(`${base}/features/admin/threads?limit=5`);
        assertEquals(res.status, 200);
      },
    );

    await t.step("GET /features/admin/activity returns activity", async () => {
      const res = await fetch(`${base}/features/admin/activity?interval=day`);
      assertEquals(res.status, 200);
    });

    await t.step("GET /admin/overview is not exposed by default", async () => {
      const res = await fetch(`${base}/admin/overview`);
      assertEquals(res.status, 404);
    });

    await t.step("withApp can opt in to /admin aliases", async () => {
      const { copilotz } = createMockCopilotz();
      withApp(copilotz as any, { exposeAdminRoutes: true });
      const result = await (copilotz as any).app.handle({
        resource: "admin",
        method: "GET",
        path: ["overview"],
      });
      assertEquals(result.status, 200);
      assertEquals(result.data.totalThreads, 42);
    });

    await t.step("withApp can log generated channel events", async () => {
      const { copilotz } = createMockCopilotz();
      const logged: Array<{
        type?: string;
        route: { ingress: string; egress: string };
        threadId: string;
      }> = [];

      withApp(copilotz as any, {
        logGeneratedEvents: (event, context) => {
          logged.push({
            type: (event as { type?: string }).type,
            route: context.route,
            threadId: context.threadId,
          });
        },
      });

      const callbackEvents: unknown[] = [];
      await (copilotz as any).app.handle({
        resource: "channels",
        method: "POST",
        path: ["web"],
        body: { content: "hi" },
        callback: (event: unknown) => callbackEvents.push(event),
      });

      assertEquals(callbackEvents.length, 2);
      assertEquals(logged, [
        {
          type: "NEW_MESSAGE",
          route: { ingress: "web", egress: "web" },
          threadId: "run-thread",
        },
      ]);
    });

    await t.step(
      "withApp boolean event logging writes inline JSON",
      async () => {
        const { copilotz } = createMockCopilotz();
        const originalLog = console.log;
        const logs: unknown[][] = [];
        console.log = (...args: unknown[]) => {
          logs.push(args);
        };

        try {
          withApp(copilotz as any, { logGeneratedEvents: true });

          await (copilotz as any).app.handle({
            resource: "channels",
            method: "POST",
            path: ["web"],
            body: { content: "hi" },
            callback: () => {},
          });
        } finally {
          console.log = originalLog;
        }

        assertEquals(logs.length, 1);
        assertEquals(logs.every((args) => args.length === 1), true);
        const prefix = "[copilotz:app:event] ";
        const records = logs.map((args) => {
          const line = String(args[0]);
          assertEquals(line.startsWith(prefix), true);
          return JSON.parse(line.slice(prefix.length));
        });
        assertEquals(records, [
          {
            type: "NEW_MESSAGE",
            threadId: "run-thread",
            route: { ingress: "web", egress: "web" },
          },
        ]);
      },
    );

    await t.step(
      "withApp event logging skips default excluded events",
      async () => {
        const { copilotz } = createMockCopilotz();
        const logged: string[] = [];

        withApp(copilotz as any, {
          logGeneratedEvents: (event) => {
            logged.push((event as { type?: string }).type ?? "unknown");
          },
        });

        await (copilotz as any).app.handle({
          resource: "channels",
          method: "POST",
          path: ["web"],
          body: { content: "include excluded" },
          callback: () => {},
        });

        assertEquals(logged, ["NEW_MESSAGE"]);
      },
    );

    await t.step(
      "withApp event logging can select default excluded event types",
      async () => {
        const { copilotz } = createMockCopilotz();
        const logged: string[] = [];

        withApp(copilotz as any, {
          logGeneratedEvents: {
            eventTypes: ["TOKEN", "ASSET_CREATED"],
            logger: (event) => {
              logged.push((event as { type?: string }).type ?? "unknown");
            },
          },
        });

        await (copilotz as any).app.handle({
          resource: "channels",
          method: "POST",
          path: ["web"],
          body: { content: "include excluded" },
          callback: () => {},
        });

        assertEquals(logged, ["TOKEN", "ASSET_CREATED"]);
      },
    );

    await t.step(
      "withApp event logging excludeEventTypes wins last",
      async () => {
        const { copilotz } = createMockCopilotz();
        const logged: string[] = [];

        withApp(copilotz as any, {
          logGeneratedEvents: {
            eventTypes: ["TOKEN", "NEW_MESSAGE"],
            excludeEventTypes: ["TOKEN"],
            logger: (event) => {
              logged.push((event as { type?: string }).type ?? "unknown");
            },
          },
        });

        await (copilotz as any).app.handle({
          resource: "channels",
          method: "POST",
          path: ["web"],
          body: { content: "include excluded" },
          callback: () => {},
        });

        assertEquals(logged, ["NEW_MESSAGE"]);
      },
    );

    // -- graph --
    await t.step("GET /graph/nodes/:id returns node", async () => {
      const res = await fetch(`${base}/graph/nodes/n-42`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.id, "n-42");
    });

    await t.step("GET /graph/nodes returns namespaced nodes", async () => {
      const res = await fetch(`${base}/graph/nodes`);
      assertEquals(res.status, 200);
    });

    await t.step("POST /graph/search returns results", async () => {
      const res = await fetch(`${base}/graph/search`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ embedding: [0.1, 0.2, 0.3] }),
      });
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.length, 1);
      assertEquals(data[0].id, "result-1");
    });

    await t.step(
      "PATCH /graph/nodes/:id requires a queue topic threadId",
      async () => {
        const res = await fetch(`${base}/graph/nodes/n-42`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Updated" }),
        });
        assertEquals(res.status, 400);
      },
    );

    await t.step(
      "PATCH /graph/nodes/:id uses safe graph mutation with topic",
      async () => {
        const res = await fetch(`${base}/graph/nodes/n-42`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            threadId: "topic-1",
            traceId: "trace-1",
            name: "Updated",
          }),
        });
        assertEquals(res.status, 200);
        const call = calls.findLast((entry) =>
          entry.method === "mutate.graph.updateNode"
        );
        assertExists(call);
        assertEquals(call.args[0], "n-42");
        assertEquals(call.args[1], { name: "Updated" });
        assertEquals(
          (call.args[2] as Record<string, unknown>).threadId,
          "topic-1",
        );
      },
    );

    await t.step(
      "DELETE /graph/nodes/:id uses safe graph mutation with header topic",
      async () => {
        const res = await fetch(`${base}/graph/nodes/n-42`, {
          method: "DELETE",
          headers: { "x-copilotz-thread-id": "topic-delete" },
        });
        assertEquals(res.status, 204);
        const call = calls.findLast((entry) =>
          entry.method === "mutate.graph.deleteNode"
        );
        assertExists(call);
        assertEquals(call.args[0], "n-42");
        assertEquals(
          (call.args[1] as Record<string, unknown>).threadId,
          "topic-delete",
        );
      },
    );

    // -- features --
    await t.step(
      "POST /features/echo/ping invokes feature handler",
      async () => {
        const res = await fetch(`${base}/features/echo/ping`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hello: "world" }),
        });
        assertEquals(res.status, 200);
        const { data } = await res.json();
        assertEquals(data.pong, true);
        assertEquals(data.received.hello, "world");
        assertEquals(data.context, null);
        assertEquals(data.namespace, "tenant-test");
        assertEquals(data.schema, null);
      },
    );

    await t.step(
      "POST /features/echo/ping passes optional request context to feature handlers",
      async () => {
        const { copilotz } = createMockCopilotz();
        withApp(copilotz as any);

        const result = await (copilotz as any).app.handle({
          resource: "features",
          method: "POST",
          path: ["echo", "ping"],
          body: { ok: true },
          context: {
            auth: { sub: "user-1", role: "admin" },
          },
        });

        assertEquals(result.status, 200);
        assertEquals(result.data, {
          pong: true,
          received: { ok: true },
          context: {
            auth: { sub: "user-1", role: "admin" },
          },
          namespace: "tenant-test",
          schema: null,
        });
      },
    );

    await t.step(
      "withApp resolveNamespace supplies request namespace to feature handlers",
      async () => {
        const { copilotz } = createMockCopilotz();
        delete (copilotz.config as { namespace?: string }).namespace;
        withApp(copilotz as any, {
          resolveNamespace: () => "tenant-resolved",
        });

        const result = await (copilotz as any).app.handle({
          resource: "features",
          method: "POST",
          path: ["echo", "ping"],
          body: { ok: true },
        });

        assertEquals(result.status, 200);
        assertEquals(
          (result.data as { namespace?: string }).namespace,
          "tenant-resolved",
        );
      },
    );

    await t.step(
      "withApp resolveSchema supplies request schema to feature handlers",
      async () => {
        const { copilotz } = createMockCopilotz();
        withApp(copilotz as any, {
          resolveSchema: () => "tenant_resolved",
        });

        const result = await (copilotz as any).app.handle({
          resource: "features",
          method: "POST",
          path: ["echo", "ping"],
          body: { ok: true },
        });

        assertEquals(result.status, 200);
        assertEquals(
          (result.data as { schema?: string }).schema,
          "tenant_resolved",
        );
      },
    );

    await t.step(
      "POST /channels/web passes namespace and schema to copilotz.run",
      async () => {
        const { copilotz, calls } = createMockCopilotz();
        withApp(copilotz as any);

        await (copilotz as any).app.handle({
          resource: "channels",
          method: "POST",
          path: ["web"],
          body: { content: "hi" },
          context: {
            namespace: "tenant-channel",
            schema: "tenant_channel",
          },
          callback: () => {},
        });

        const runCall = calls.find((call) => call.method === "run");
        assertExists(runCall);
        assertEquals(runCall.args[1], {
          namespace: "tenant-channel",
          schema: "tenant_channel",
        });
      },
    );

    await t.step(
      "POST /channels/inspect passes optional request context to channel adapters",
      async () => {
        const { copilotz } = createMockCopilotz();
        withApp(copilotz as any);

        const result = await (copilotz as any).app.handle({
          resource: "channels",
          method: "POST",
          path: ["inspect"],
          body: { ok: true },
          context: {
            auth: { sub: "user-1", role: "admin" },
          },
        });

        assertEquals(result.status, 200);
        assertEquals(result.data, {
          context: {
            auth: { sub: "user-1", role: "admin" },
          },
        });
      },
    );

    await t.step(
      "POST /channels/web/to/zendesk passes optional request context to egress adapters",
      async () => {
        const { copilotz, deliveries } = createMockCopilotz();
        withApp(copilotz as any);

        await (copilotz as any).app.handle({
          resource: "channels",
          method: "POST",
          path: ["web", "to", "zendesk"],
          body: {
            content: "hi from web",
            thread: { id: "zd-thread" },
          },
          context: {
            auth: { sub: "user-1", role: "admin" },
            channels: { zendesk: { appId: "test-app" } },
          },
        });

        await waitFor(() => deliveries.length === 1);
        assertEquals(deliveries[0].context, {
          auth: { sub: "user-1", role: "admin" },
          channels: { zendesk: { appId: "test-app" } },
        });
      },
    );

    await t.step(
      "GET /features/echo/ping also works (method wildcard)",
      async () => {
        const res = await fetch(`${base}/features/echo/ping`);
        assertEquals(res.status, 200);
        const { data } = await res.json();
        assertEquals(data.pong, true);
      },
    );

    // -- 404 --
    await t.step("GET /nonexistent returns 404", async () => {
      const res = await fetch(`${base}/nonexistent`);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });

    await t.step("GET /threads/t-1/nonexistent returns 404", async () => {
      const res = await fetch(`${base}/threads/t-1/nonexistent`);
      assertEquals(res.status, 404);
      await res.body?.cancel();
    });

    // -- channels/web streaming --
    await t.step("POST /channels/web streams SSE events", async () => {
      const res = await fetch(`${base}/channels/web`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hi", threadId: "t-1" }),
      });
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/event-stream");

      const text = await res.text();
      const events = text
        .split("\n\n")
        .filter(Boolean)
        .map((block) => {
          const dataLine = block.split("\n").find((l) =>
            l.startsWith("data: ")
          );
          return dataLine ? JSON.parse(dataLine.slice(6)) : null;
        })
        .filter(Boolean);

      assertEquals(events.length, 2);
      assertEquals(events[0].type, "TOKEN");
      assertEquals(events[1].type, "NEW_MESSAGE");
    });

    await t.step(
      "POST /channels/web/to/zendesk accepts detached delivery",
      async () => {
        const res = await fetch(`${base}/channels/web/to/zendesk`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: "hi from web",
            thread: { id: "zd-thread" },
          }),
        });
        assertEquals(res.status, 202);
        const { data } = await res.json();
        assertEquals(data.status, "accepted");
        assertEquals(data.accepted, 1);
        assertEquals(data.route.ingress, "web");
        assertEquals(data.route.egress, "zendesk");

        await waitFor(() => deliveries.length === 1);
        assertEquals(deliveries[0].route, {
          ingress: "web",
          egress: "zendesk",
        });
        assertEquals(deliveries[0].threadId, "zd-thread");
        assertEquals(deliveries[0].events, ["TOKEN", "NEW_MESSAGE"]);
      },
    );

    // -- resources() introspection --
    await t.step("resources() lists all registered resources", () => {
      const descriptors = extended.app.resources();
      const names = descriptors.map((d: { name: string }) => d.name);
      assertEquals(names.includes("agents"), true);
      assertEquals(names.includes("threads"), true);
      assertEquals(names.includes("collections"), true);
      assertEquals(names.includes("graph"), true);
      assertEquals(names.includes("channels"), true);
      assertEquals(names.includes("features"), true);
    });

    // -- withApp idempotency --
    await t.step("withApp called twice returns same instance", () => {
      const second = withApp(extended as never);
      assertEquals(second, extended);
    });
  } finally {
    await server.shutdown();
  }
});
