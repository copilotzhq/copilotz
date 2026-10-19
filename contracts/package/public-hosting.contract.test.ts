import { assert, assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../../runtime/testing/ominipg.ts";
import { createCopilotz, defineAction } from "../../index.ts";
import { createCopilotz as createWorker } from "../../worker.ts";
import { listen as denoListen } from "../../runtime/adapters/deno/index.ts";
import { listen as nodeListen } from "../../runtime/adapters/node/index.ts";
import { createHypervisor } from "../../dependencies/oxian-hypervisor.ts";

const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
for (
  const [runtime, listen] of [["Deno", denoListen], [
    "Node",
    nodeListen,
  ]] as const
) {
  Deno.test({
    name:
      `${runtime} public owner listener admits worker capabilities and owns only its listener`,
    ignore: !url,
    async fn() {
      const schema = `hosting_${crypto.randomUUID().replaceAll("-", "")}`;
      let executions = 0;
      const actions = {
        echo: defineAction({
          id: "hosting.echo",
          execute(input: { value: string }) {
            executions++;
            return input.value;
          },
        }),
      };
      const controller = new AbortController();
      const app = await createCopilotz({
        role: "gateway",
        database: { url },
        databaseSchema: schema,
        namespace: "hosting",
        actions,
        target: { workerId: "hosting-worker" },
        transports: [{ type: "websocket", config: { path: "/workers" } }],
        admit(context) {
          if (context.credential.capability !== "test-admission") {
            throw new Error("denied");
          }
          return {
            definition: {
              workerId: context.identity.workerId,
              providerId: "test",
              workloads: [...context.workloads],
              capacity: context.capacity,
              providerConfig: {},
              labels: {},
            },
            sessionGeneration: 1,
            authenticatedWith: context.credential.kind,
            resume: {
              credential: { kind: "resume", capability: "test-resume" },
              expiresAtMs: Date.now() + 60000,
            },
          };
        },
      });
      let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
      try {
        assert(!Object.hasOwn(app, "hypervisor"));
        const listener = await listen(app, { signal: controller.signal });
        assertEquals((await fetch(listener.url)).status, 404);
        if (runtime === "Node") {
          await assertRejects(() => nodeListen(app, { port: listener.port }));
        }
        const workerUrl = new URL("/workers", listener.url);
        workerUrl.protocol = "ws:";
        worker = await createWorker({
          role: "worker",
          id: "hosting-worker",
          databaseSchema: schema,
          namespace: "hosting",
          actions,
          transport: {
            type: "websocket",
            config: { url: workerUrl, allowInsecureLoopback: true },
          },
          activate: () => ({
            workerId: "hosting-worker",
            attemptId: "attempt",
            epoch: 1,
          }),
          register: () => ({
            credential: { kind: "registration", capability: "test-admission" },
            expiresAtMs: Date.now() + 60000,
          }),
          handshake() {},
          reconnectDelay: false,
        });
        await worker.ready;
        const options = { idempotencyKey: "echo" };
        assertEquals(
          await app.actions.echo({ value: "remote" }, options),
          "remote",
        );
        assertEquals(
          await app.actions.echo({ value: "remote" }, options),
          "remote",
        );
        assertEquals(executions, 1);
        await listener.shutdown();
        await listener.finished;
        await worker.closed;
        await worker.close();
        worker = undefined;
        assert((await app.listOperations()).length > 0);
        // Closing a listener leaves the owner usable and permits replacement.
        const next = await listen(app);
        const racing = runtime === "Node" ? nodeListen(app) : undefined;
        // Observe rejection before close can complete the asynchronous bind.
        const raced = racing?.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await app.close();
        await next.finished;
        if (raced) {
          const result = await raced;
          if ("value" in result) await result.value.finished;
          else assert(result.error instanceof TypeError);
        }
        await assertRejects(async () => await listen(app), TypeError, "closed");
      } finally {
        controller.abort();
        await worker?.close();
        await app.close();
      }
    },
  });
}

Deno.test({
  name:
    "dispatcher binding is frozen, one-shot, revoked, and caller-owned on cancellation",
  ignore: !url,
  async fn() {
    const controller = new AbortController();
    let calls = 0;
    let hypervisor: ReturnType<typeof createHypervisor> | undefined;
    let ready: ((event: never) => unknown) | undefined;
    const schema = `hosting_cancel_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await assertRejects(
        () =>
          createCopilotz({
            role: "gateway",
            database: { url },
            databaseSchema: schema,
            signal: controller.signal,
            dispatcher(binding) {
              calls++;
              assert(Object.isFrozen(binding));
              assert(Object.isFrozen(binding.workerCalls));
              assert(Object.isFrozen(binding.lifecycle));
              ready = binding.lifecycle.onReady;
              hypervisor = createHypervisor({
                transports: [{
                  type: "in-process",
                  config: { topic: crypto.randomUUID() },
                }],
                workerCalls: binding.workerCalls,
              }, binding.lifecycle);
              controller.abort(new Error("cancelled construction"));
              return hypervisor;
            },
          }),
        Error,
        "cancelled construction",
      );
      assertEquals(calls, 1);
      assert(hypervisor!.snapshot().acceptingConnections);
      await assertRejects(
        async () => await ready!({} as never),
        Error,
        "closed",
      );
    } finally {
      await hypervisor?.shutdown();
    }
  },
});

Deno.test("unsupported dispatcher objects are refused before persistence opens", async () => {
  await assertRejects(
    () =>
      // @ts-expect-error runtime validation of untyped host configuration
      createCopilotz({
        role: "gateway",
        dispatcher: {
          dispatch() {
            throw new Error("must not run");
          },
        },
      }),
    TypeError,
    "binding callback",
  );
});

Deno.test({
  name:
    "abort during owner construction refuses startup and releases the attachment before storage",
  ignore: !url,
  async fn() {
    const database = await createTestDatabase({ url });
    const controller = new AbortController();
    const cause = new Error("aborted while constructing owner");
    const schema = `hosting_abort_${crypto.randomUUID().replaceAll("-", "")}`;
    let armed = false;
    let triggered = false;
    const wrapped = {
      ...database,
      async query<T extends Record<string, unknown>>(
        sql: string,
        params?: unknown[],
      ) {
        if (armed && !triggered) {
          triggered = true;
          controller.abort(cause);
        }
        return await database.query<T>(sql, params);
      },
    };
    try {
      await assertRejects(
        () =>
          createCopilotz({
            role: "gateway",
            database: wrapped,
            databaseSchema: schema,
            signal: controller.signal,
            dispatcher() {
              armed = true;
              return {
                dispatch() {
                  throw new Error("No work expected");
                },
              };
            },
          }),
        Error,
        cause.message,
      );
      assert(triggered);
      assertEquals((await database.query("SELECT 1 AS alive")).rows[0], {
        alive: 1,
      });
      const restarted = await createCopilotz({
        role: "gateway",
        database,
        databaseSchema: schema,
      });
      await restarted.close();
    } finally {
      await database.close();
    }
  },
});
