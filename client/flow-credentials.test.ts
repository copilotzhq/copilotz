import { assertEquals, assertRejects } from "@std/assert";
import { CopilotzHttpError, createCopilotzClient } from "./index.ts";
import { createBrowserRuntime } from "./web/index.ts";

Deno.test("completed flow submission replay binds result and observation requests to its credential", async () => {
  const requests: { path: string; credential: string | null }[] = [];
  const client = createCopilotzClient({
    baseUrl: "https://flow.test/api",
    fetch: (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({
        path,
        credential: request.headers.get("x-copilotz-flow"),
      });
      if (path === "/api/actions/start") {
        return Promise.resolve(Response.json({
          data: { operationId: "started-flow" },
        }, {
          status: 202,
          headers: {
            "x-copilotz-flow": "signed-flow",
            "x-copilotz-flow-action": "continue",
          },
        }));
      }
      if (path === "/api/operations/observe") {
        // Reject after recording the header; the transport must not retry a 403.
        return Promise.resolve(Response.json({
          error: { code: "forbidden", message: "Fixture observation ended." },
        }, { status: 403 }));
      }
      return Promise.resolve(Response.json({ data: {}, seq: "1" }));
    },
  });
  const receipt = await client.actions.submit("start", {}, {
    idempotencyKey: "original-flow",
  });
  await client.operations.result(receipt.operationId);
  await client.operations.get(receipt.operationId);
  await assertRejects(
    () =>
      client.operations.observe({
        operationIds: [receipt.operationId],
        onFrame() {},
      }),
    CopilotzHttpError,
    "Fixture observation ended.",
  );
  await client.operations.get("unrelated");
  assertEquals(requests, [
    { path: "/api/actions/start", credential: null },
    {
      path: "/api/operations/started-flow/result",
      credential: "signed-flow",
    },
    { path: "/api/operations/started-flow", credential: "signed-flow" },
    { path: "/api/operations/observe", credential: "signed-flow" },
    { path: "/api/operations/unrelated", credential: null },
  ]);
});

Deno.test("browser Action transport retains exact operation flow credentials after session projection", async () => {
  const seen: { path: string; credential: string | null }[] = [];
  const client = createCopilotzClient({
    baseUrl: "https://flow.test/api",
    fetch: (input, init) => {
      assertEquals(init?.credentials, "include");
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      seen.push({
        path,
        credential: request.headers.get("x-copilotz-flow"),
      });
      if (request.method === "POST") {
        const operationId = path.endsWith("/start") ? "start" : "continue";
        return Promise.resolve(
          Response.json({ data: { operationId } }, { status: 202 }),
        );
      }
      const starting = path === "/api/operations/start/result";
      return Promise.resolve(Response.json({ data: { ok: true }, seq: "1" }, {
        headers: starting
          ? {
            "x-copilotz-flow": "signed-flow",
            "x-copilotz-flow-action": "continue",
          }
          : { "x-copilotz-flow": "" },
      }));
    },
  });
  const runtime = await createBrowserRuntime({
    plugins: [{
      id: "fixture.auth",
      actions: {
        start: { id: "auth.start", placement: "server" },
        continue: { id: "auth.continue", placement: "server" },
      },
    }],
    actions: {
      async invoke(id, input, options) {
        const receipt = await client.actions.submit(id, input, options);
        options.accepted(receipt.operationId);
        return await client.operations.result(
          receipt.operationId,
          options.signal,
        );
      },
      async cancel(id) {
        await client.operations.cancel(id);
      },
    },
  });
  try {
    assertEquals(await runtime.actions.start({}).result(), { ok: true });
    assertEquals(await runtime.actions.continue({}).result(), { ok: true });
    await client.operations.get("continue");
    assertEquals(seen, [
      { path: "/api/actions/start", credential: null },
      { path: "/api/operations/start/result", credential: null },
      { path: "/api/actions/continue", credential: "signed-flow" },
      { path: "/api/operations/continue/result", credential: "signed-flow" },
      { path: "/api/operations/continue", credential: "signed-flow" },
    ]);
  } finally {
    runtime.dispose();
  }
});

Deno.test("completed flow replay and observation retain only their original credential across newer flows", async () => {
  const seen: { path: string; flow: string | null }[] = [];
  let starts = 0;
  const client = createCopilotzClient({
    baseUrl: "https://flow.test/api",
    fetch: (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      seen.push({ path, flow: request.headers.get("x-copilotz-flow") });
      if (path.endsWith("/observe")) {
        return Promise.resolve(
          Response.json({
            error: { code: "forbidden", message: "end observation" },
          }, { status: 403 }),
        );
      }
      if (path.endsWith("/start")) {
        starts++;
        return Promise.resolve(
          Response.json({ data: { operationId: `start-${starts}` } }, {
            status: 202,
            headers: {
              "x-copilotz-flow": `flow-${starts}`,
              "x-copilotz-flow-action": "callback",
            },
          }),
        );
      }
      if (request.method === "POST") {
        return Promise.resolve(
          Response.json({ data: { operationId: "callback" } }, {
            status: 202,
            headers: { "x-copilotz-flow": "" },
          }),
        );
      }
      return Promise.resolve(Response.json({ data: {}, seq: "1" }));
    },
  });
  await client.actions.submit("start", {}, { idempotencyKey: "start-1" });
  await client.actions.submit("callback", {}, {
    idempotencyKey: "callback",
  });
  await client.operations.result("callback");
  await assertRejects(
    () =>
      client.operations.observe({ operationIds: ["callback"], onFrame() {} }),
    CopilotzHttpError,
  );
  await client.actions.submit("start", {}, { idempotencyKey: "start-2" });
  await client.actions.submit("callback", {}, {
    idempotencyKey: "callback",
  });
  await client.operations.result("callback");
  await client.operations.get("unrelated");
  assertEquals(seen.map((request) => request.flow), [
    null,
    "flow-1",
    "flow-1",
    "flow-1",
    null,
    "flow-1",
    "flow-1",
    null,
  ]);
});
