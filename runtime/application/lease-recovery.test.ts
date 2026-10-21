import { assert, assertEquals } from "@std/assert";
import { createCopilotz, defineAction } from "../../index.ts";
import {
  createHypervisor,
  type Hypervisor,
} from "../../dependencies/oxian-hypervisor.ts";
import { createCopilotzGateway } from "./gateway.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { bindSchemaOwner } from "../engine/commands.ts";

for (const mode of ["in-process", "websocket"] as const) {
  Deno.test(`${mode}: starved worker session recovers mid-traffic without expiring the SQL owner`, async () => {
    const database = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") || ":memory:",
    });
    const schema = `lease_recovery_${crypto.randomUUID().replaceAll("-", "")}`;
    const transport = {
      type: "in-process",
      config: { topic: crypto.randomUUID() },
    } as const;
    const entered = Promise.withResolvers<void>();
    const reconnected = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const timers = new Map<object, { callback(): void; delay: number }>();
    let clock = Date.now(), ready = 0, executions = 0;
    const disconnects: string[] = [];
    let hypervisor: Hypervisor | undefined;
    let generation = 0;
    const actions = {
      echo: defineAction({
        id: "lease.echo",
        async execute(input: { wait?: boolean }, context) {
          if (input.wait && ++executions === 1) {
            entered.resolve();
            await Promise.race([
              release.promise,
              new Promise<never>((_, reject) => {
                if (context.signal.aborted) reject(context.signal.reason);
                else {context.signal.addEventListener(
                    "abort",
                    () => reject(context.signal.reason),
                    { once: true },
                  );}
              }),
            ]);
          }
          return "ok";
        },
      }),
    };
    const gateway = await createCopilotzGateway({
      database,
      databaseSchema: schema,
      namespace: "scope",
      actions,
      target: { workerId: "worker" },
      dispatcher({ workerCalls, lifecycle }) {
        hypervisor = createHypervisor({
          transports: [
            mode === "in-process"
              ? transport
              : { type: "websocket", config: { path: "/worker" } },
          ],
          ...(mode === "websocket"
            ? {
              admit(context) {
                assert(
                  ["test-worker", "resume-worker"].includes(
                    context.credential.capability,
                  ),
                );
                return {
                  definition: {
                    workerId: context.identity.workerId,
                    providerId: "test",
                    workloads: [...context.workloads],
                    capacity: context.capacity,
                    providerConfig: {},
                    labels: {},
                  },
                  sessionGeneration: ++generation,
                  authenticatedWith: context.credential.kind,
                  resume: {
                    credential: {
                      kind: "resume" as const,
                      capability: "resume-worker",
                    },
                    expiresAtMs: clock + 60_000,
                  },
                };
              },
            }
            : {}),
          workerCalls,
          clock: () => clock,
          config: {
            heartbeatIntervalMs: 250,
            leaseTimeoutMs: 1_000,
            leaseSweepIntervalMs: 50,
          },
          scheduler: {
            schedule(callback, delay) {
              const token = {};
              timers.set(token, { callback, delay });
              return token;
            },
            cancel(token) {
              timers.delete(token as object);
            },
          },
        }, {
          ...lifecycle,
          async onReady(event) {
            await lifecycle.onReady?.(event);
            if (++ready === 2) reconnected.resolve();
          },
          async onDisconnect(event) {
            disconnects.push(event.reason);
            await lifecycle.onDisconnect?.(event);
          },
        });
        return hypervisor;
      },
    });
    const listener = mode === "websocket"
      ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
      : undefined;
    const url = listener ? new URL("/worker", listener.url) : undefined;
    if (url) url.protocol = "ws:";
    const worker = await createCopilotz({
      role: "worker",
      id: "worker",
      transport: mode === "in-process" ? transport : {
        type: "websocket",
        config: { url: url!, allowInsecureLoopback: true },
      },
      ...(mode === "websocket"
        ? {
          activate: () => ({
            workerId: "worker",
            attemptId: "attempt",
            epoch: 1,
          }),
          register: () => ({
            credential: {
              kind: "registration" as const,
              capability: "test-worker",
            },
            expiresAtMs: Date.now() + 60_000,
          }),
        }
        : {}),
      namespace: "scope",
      actions,
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const bounded = <T>(promise: Promise<T>, label: string) =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          watchdog = setTimeout(
            () =>
              reject(
                new Error(
                  `lease recovery exceeded five seconds: ${label}; ready=${ready}; disconnects=${disconnects}`,
                ),
              ),
            5_000,
          );
        }),
      ]).finally(() => clearTimeout(watchdog));
    try {
      await worker.ready;
      const owner = await bindSchemaOwner(database, schema)();
      const epoch = owner.epoch;
      const pending = gateway.actions.echo({ wait: true }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await bounded(entered.promise, "entered");
      // Advance the host's monotonic clock beyond the shortened lease while no
      // heartbeat can run, then run its overdue sweep. This deterministically
      // models an event-loop pause without burning CPU or sleeping in the test.
      clock += 1_001;
      const sweep = [...timers].find(([, timer]) => timer.delay === 50);
      assert(sweep);
      timers.delete(sweep[0]);
      sweep[1].callback();
      if (mode === "websocket") {
        await bounded(reconnected.promise, "reconnected");
        assert(disconnects.includes("lease_expired"));
      } else {
        assertEquals(disconnects, []);
        assertEquals(
          ready,
          1,
          "colocated worker shares the stalled event loop",
        );
      }
      assertEquals(
        await bounded(gateway.actions.echo({}), "new command"),
        "ok",
      );
      release.resolve();
      const result = await bounded(pending, "pending");
      if ("value" in result) assertEquals(result.value, "ok");
      else assert(result.error instanceof Error);
      assertEquals((await bindSchemaOwner(database, schema)()).epoch, epoch);
      assertEquals(owner.state, "ready");
    } finally {
      release.resolve();
      await worker.close();
      await listener?.shutdown();
      await gateway.close();
      await hypervisor?.shutdown();
      assertEquals(timers.size, 0, "lease timers drain at shutdown");
      await database.query(`DROP SCHEMA "${schema}" CASCADE`);
      await database.close();
    }
  });
}
