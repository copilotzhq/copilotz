import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineAction } from "../runtime/actions/define.ts";
import { definePlugin, defineProcessor } from "../runtime/plugins/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import {
  createTestApplication,
  defineTestServerFacade,
} from "../runtime/testing/server-authorization.test.ts";
import { serverPlugin } from "../plugins/server/index.ts";
import { createServerFacadeFetchHandler } from "./facade.ts";
import { createCopilotzClient } from "../client/index.ts";
import { createBrowserPorts } from "../client/web/ports.ts";
import { createBrowserRuntime } from "../client/web/runtime.ts";
import { ActionFailure } from "../client/web/ports.ts";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:";
if (url !== ":memory:") {
  const parsed = new URL(url);
  if (parsed.port !== "55439" || !parsed.pathname.startsWith("/result_")) {
    throw new Error("Use PostgreSQL port 55439 and a result_* database.");
  }
}

Deno.test("Action result: create-then-send latency harness", async () => {
  const database = await createTestDatabase({ url });
  const schema = `result_${crypto.randomUUID().replaceAll("-", "")}`;
  let deliveries = 0;
  const app = await createTestApplication({
    database,
    namespace: "test",
    databaseSchema: schema,
    plugins: [
      definePlugin({
        id: "test.result",
        version: "1",
        actions: {
          create: defineAction({
            id: "test.create",
            async execute() {
              await delay(30);
              return { threadId: "thread" };
            },
          }),
          send: defineAction({
            id: "test.send",
            async execute() {
              await delay(20);
              return { messageId: "message" };
            },
          }),
        },
        processors: {
          downstream: defineProcessor({
            id: "test.downstream",
            on: [{ eventType: "test.create.completed" }],
            async handle() {
              await delay(600);
              deliveries++;
            },
          }),
        },
      }),
      definePlugin({
        ...serverPlugin,
        resources: {
          server: { default: defineTestServerFacade() },
        },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(app);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  const runtime = await createBrowserRuntime({
    ...createBrowserPorts(client),
    plugins: [{
      id: "test.browser",
      actions: {
        create: { id: "test.create", placement: "server" },
        send: { id: "test.send", placement: "server" },
      },
    }],
  });
  try {
    const elapsed: number[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const start = performance.now();
      const created = runtime.actions.create({});
      assertEquals(await created.result(), { threadId: "thread" });
      assertEquals(created.status, "completed");
      assertEquals(await runtime.actions.send({}).result(), {
        messageId: "message",
      });
      elapsed.push(Math.round(performance.now() - start));
      await created.settled();
      assertEquals(deliveries, sample + 1);
    }
    console.log(
      JSON.stringify({
        backend: url === ":memory:" ? "pglite" : "postgres",
        createThenSendMs: elapsed,
      }),
    );
  } finally {
    runtime.dispose();
    await app.close();
    if (url !== ":memory:") {
      await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await database.close();
  }
});

Deno.test("Action result: failure, downstream dead letter, replay and checkpoint resume", async () => {
  const database = await createTestDatabase({ url });
  const schema = `result_${crypto.randomUUID().replaceAll("-", "")}`;
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let executions = 0;
  let operationId = "";
  const app = await createTestApplication({
    database,
    namespace: "test",
    databaseSchema: schema,
    plugins: [
      definePlugin({
        id: "test.failures",
        version: "1",
        actions: {
          create: defineAction({
            id: "test.create",
            execute() {
              executions++;
              return { threadId: "thread" };
            },
          }),
          fail: defineAction({
            id: "test.fail",
            execute() {
              throw new Error("Action failure");
            },
          }),
        },
        processors: {
          downstream: defineProcessor({
            id: "test.downstream",
            on: [{ eventType: "test.create.completed" }],
            async handle() {
              entered.resolve();
              await release.promise;
              throw Object.assign(new Error("Downstream failure"), {
                retryable: false,
              });
            },
          }),
        },
      }),
      definePlugin({
        ...serverPlugin,
        resources: { server: { default: defineTestServerFacade() } },
      }),
    ],
  });
  const handler = createServerFacadeFetchHandler(app);
  const client = createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: ((url, init) => handler(new Request(url, init))) as typeof fetch,
  });
  const ports = createBrowserPorts(client);
  const runtime = await createBrowserRuntime({
    ...ports,
    actions: {
      ...ports.actions,
      invoke(id, input, options) {
        return ports.actions.invoke(id, input, {
          ...options,
          accepted(id) {
            operationId = id;
            options.accepted(id);
          },
        });
      },
    },
    plugins: [{
      id: "test.browser",
      actions: {
        create: { id: "test.create", placement: "server" },
        fail: { id: "test.fail", placement: "server" },
      },
    }],
  });
  const abort = new AbortController();
  // Deadline catches a regression to result-at-settlement without hanging tests.
  const timer = setTimeout(() => {
    release.resolve();
    abort.abort(new Error("Completion deadline exceeded"));
  }, 10_000);
  try {
    const handle = runtime.actions.create({});
    const value = await handle.result();
    await entered.promise;
    assertEquals(value, { threadId: "thread" });
    assertEquals(handle.status, "completed");
    const id = operationId;
    assertEquals(
      (await client.operations.get(id) as { data: { state: string } }).data
        .state,
      "running",
    );
    let settled = false;
    const settlement = handle.settled().finally(() => {
      settled = true;
    });
    void settlement.catch(() => {});
    await delay(20);
    assertEquals(settled, false);
    const completed = Promise.withResolvers<string>();
    const observation = client.operations.observe({
      operationIds: [id],
      signal: abort.signal,
      onFrame(frame) {
        if (
          frame.kind === "output" &&
          frame.output.type === "test.create.completed"
        ) {
          completed.resolve(frame.checkpoint!);
        }
      },
    });
    void observation.catch(() => {});
    const checkpoint = await completed.promise;
    assert(checkpoint);
    assertEquals(
      settled,
      false,
      "the Action lifecycle is observable before settlement",
    );
    abort.abort();
    await observation.catch(() => {});
    // Replay through exactly the same durable admission key, while work is pending.
    const replay = await client.actions.submit("create", {}, {
      idempotencyKey: handle.id,
    });
    assertEquals(replay.operationId, id);
    assertEquals((await client.operations.result(id)).value, value);
    assertEquals(executions, 1);
    // The trusted host client uses the same completion boundary.
    assertEquals(await app.host.actions.create({}), value);
    assertEquals(settled, false);
    release.resolve();
    await assertRejects(() => settlement, ActionFailure, "settlement failed");
    assertEquals(await handle.result(), value);
    assertEquals(handle.status, "completed");
    assertEquals(handle.error, undefined);
    const frames: Record<string, unknown>[] = [];
    await client.operations.observe({
      operationIds: [id],
      checkpoint,
      onFrame(frame) {
        if (frame.kind === "output") frames.push(frame.output);
      },
    });
    assertEquals(
      frames.some((frame) => frame.type === "test.create.completed"),
      false,
    );
    assertEquals(frames.at(-1)?.type, "operation.settled");
    assertEquals(frames.at(-1)?.outcome, "failed");
    assertEquals((await client.operations.settled(id)).outcome, "failed");
    const snapshot = await client.operations.get(id) as {
      data: { state: string; outcome: string; settledAt: string };
    };
    assertEquals(snapshot.data.state, "settled");
    assertEquals(snapshot.data.outcome, "failed");
    assert(typeof snapshot.data.settledAt === "string");
    assertEquals((await client.operations.result(id)).value, value);
    const settledReplay = await client.actions.submit("create", {}, {
      idempotencyKey: handle.id,
    });
    assertEquals(settledReplay.operationId, id);
    assertEquals(settledReplay.status, "settled");
    assertEquals((await client.operations.result(id)).value, value);
    assertEquals(
      executions,
      2,
      "host invocation ran once; replay never re-executes",
    );
    const failed = runtime.actions.fail({});
    await assertRejects(
      () => failed.result(),
      Error,
      "Action execution failed",
    );
    assertEquals(failed.status, "failed");
    await assertRejects(() => failed.settled());
  } finally {
    clearTimeout(timer);
    release.resolve();
    abort.abort();
    runtime.dispose();
    await app.close();
    if (url !== ":memory:") {
      await database.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await database.close();
  }
});
