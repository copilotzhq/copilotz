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
      return id === "not-found" ? undefined : { id, name: "Test Thread" };
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
  };

  const mockAssets = {
    getBase64: async (ref: string, _opts?: unknown) => {
      record("assets.getBase64", ref);
      return { base64: "AQID", mime: "image/png" };
    },
    getDataUrl: async (ref: string, _opts?: unknown) => {
      record("assets.getDataUrl", ref);
      return "data:image/png;base64,AQID";
    },
  };

  const mockCollections = {
    getCollectionNames: () => ["customers", "orders"],
    hasCollection: (name: string) => ["customers", "orders"].includes(name),
    withNamespace: () => ({}),
  };

  const copilotz = {
    ops: mockOps,
    assets: mockAssets,
    collections: mockCollections,
    config: {
      agents: [
        { id: "agent-1", name: "Helper", description: "A test agent", public: true },
      ],
      features: [
        {
          name: "echo",
          actions: {
            ping: async (req: any) => ({
              status: 200,
              data: { pong: true, received: req.body },
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
          handler: async (ctx: any, c: any) => {
            if (!ctx.callback) throw { status: 400, message: "Web channel requires a callback for streaming" };
            const controller = await c.run(ctx.body);
            for await (const event of controller.events) {
              ctx.callback(event);
            }
            return { status: "ok" };
          },
        },
      ],
    },
    run: async (msg: unknown) => {
      record("run", msg);
      return {
        events: (async function* () {
          yield { type: "TOKEN", data: { text: "hello" } };
          yield { type: "NEW_MESSAGE", data: { content: "hello world" } };
        })(),
      };
    },
    schema: {},
  };

  return { copilotz, calls };
}

// ---------------------------------------------------------------------------
// HTTP helper — Deno.serve adapter that pipes to handle()
// ---------------------------------------------------------------------------

function createServer(copilotz: ReturnType<typeof withApp>) {
  const server = Deno.serve({ port: 0, onListen() {} }, async (req) => {
    const url = new URL(req.url);
    const segments = url.pathname.replace(/^\/v1\//, "").split("/").filter(Boolean);
    const [resource, ...path] = segments;

    if (!resource) {
      return Response.json({ error: "Resource required" }, { status: 400 });
    }

    const appReq: AppRequest = {
      resource,
      method: req.method as AppRequest["method"],
      path,
      query: Object.fromEntries(url.searchParams),
      body: req.method !== "GET" && req.method !== "DELETE"
        ? await req.json().catch(() => undefined)
        : undefined,
      headers: Object.fromEntries(req.headers),
    };

    // SSE callback for channels
    if (resource === "channels") {
      const body = appReq.body;
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      appReq.callback = (event: unknown) => {
        const e = event as { type?: string };
        writer.write(
          encoder.encode(`event: ${e.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      };

      copilotz.app.handle({ ...appReq, body }).then(() => writer.close()).catch(() => writer.close());

      return new Response(readable, {
        headers: { "content-type": "text/event-stream" },
      });
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
  });

  const addr = server.addr;
  const base = `http://localhost:${addr.port}/v1`;

  return { server, base };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("withApp — handle() routes and Deno.serve integration", async (t) => {
  const { copilotz } = createMockCopilotz();
  // deno-lint-ignore no-explicit-any
  const extended = withApp(copilotz as any);
  const { server, base } = createServer(extended);

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

    // -- threads/:id/events --
    await t.step("GET /threads/:id/events returns pending event", async () => {
      const res = await fetch(`${base}/threads/t-100/events`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.status, "pending");
    });

    await t.step("GET /threads/:id/events?status=processing returns processing event", async () => {
      const res = await fetch(`${base}/threads/t-100/events?status=processing`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.status, "processing");
    });

    await t.step("POST /threads/:id/events enqueues event", async () => {
      const res = await fetch(`${base}/threads/t-100/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "MESSAGE", data: { content: "hi" } }),
      });
      assertEquals(res.status, 201);
    });

    // -- participants --
    await t.step("GET /participants/:id returns participant", async () => {
      const res = await fetch(`${base}/participants/user-1`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.name, "Alice");
    });

    await t.step("PUT /participants/:id updates participant", async () => {
      const res = await fetch(`${base}/participants/user-1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ age: 30 }),
      });
      assertEquals(res.status, 200);
    });

    // -- collections --
    await t.step("GET /collections returns collection names", async () => {
      const res = await fetch(`${base}/collections`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data, ["customers", "orders"]);
    });

    // -- admin (via features) --
    await t.step("GET /features/admin/overview returns overview", async () => {
      const res = await fetch(`${base}/features/admin/overview`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.totalThreads, 42);
    });

    await t.step("GET /features/admin/threads returns thread list", async () => {
      const res = await fetch(`${base}/features/admin/threads?limit=5`);
      assertEquals(res.status, 200);
    });

    await t.step("GET /features/admin/activity returns activity", async () => {
      const res = await fetch(`${base}/features/admin/activity?interval=day`);
      assertEquals(res.status, 200);
    });

    // -- graph --
    await t.step("GET /graph/nodes/:id returns node", async () => {
      const res = await fetch(`${base}/graph/nodes/n-42`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.id, "n-42");
    });

    await t.step("GET /graph/namespaces/:ns/nodes returns nodes", async () => {
      const res = await fetch(`${base}/graph/namespaces/test-ns/nodes`);
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

    // -- features --
    await t.step("POST /features/echo/ping invokes feature handler", async () => {
      const res = await fetch(`${base}/features/echo/ping`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.pong, true);
      assertEquals(data.received.hello, "world");
    });

    await t.step("GET /features/echo/ping also works (method wildcard)", async () => {
      const res = await fetch(`${base}/features/echo/ping`);
      assertEquals(res.status, 200);
      const { data } = await res.json();
      assertEquals(data.pong, true);
    });

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
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          return dataLine ? JSON.parse(dataLine.slice(6)) : null;
        })
        .filter(Boolean);

      assertEquals(events.length, 2);
      assertEquals(events[0].type, "TOKEN");
      assertEquals(events[1].type, "NEW_MESSAGE");
    });

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
