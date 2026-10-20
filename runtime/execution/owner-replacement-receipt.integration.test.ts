import { hostIngressProof } from "../application/ingress/authority.ts";
import { defineAction } from "../actions/define.ts";
import type { RuntimeContext } from "../actions/types.ts";
import { listen } from "../adapters/deno/listen.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { defineCollection } from "../collections/definition.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createCopilotzGateway } from "../application/gateway.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { createEventStore } from "../events/index.ts";
import {
  createHypervisor,
  type WorkerCallOptions,
} from "../../dependencies/oxian-hypervisor.ts";
import { createWorker, type Worker } from "../../dependencies/oxian-worker.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import { recoverOwnerReceipt } from "./owner-capability-worker.ts";
import {
  type CapabilityCall,
  encodeCapability,
  readCapability,
} from "./owner-capability-wire.ts";

for (const mode of ["processor", "action"] as const) {
  for (const transport of ["in-process", "websocket"] as const) {
    Deno.test(`${transport} ${mode}: admitted replacement worker replays one logical transaction and only then recovers its receipt`, async () => {
      const database = await createOwnerTestDatabase();
      const topic = crypto.randomUUID();
      const records = defineCollection({
        name: "replacement_record",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            namespace: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "namespace", "text"],
        } as const,
      });
      let selected = "original",
        executions = 0,
        failTerminal = false,
        terminalFailures = 0;
      const finished = Promise.withResolvers<void>();

      let receipt: NonNullable<CapabilityCall["receipt"]> | undefined;
      const observed: string[] = [];
      const mutate = async (
        ctx: Pick<RuntimeContext, "transaction" | "signal">,
      ) => {
        executions++;
        if (executions === 2) {
          assertEquals(await recoverOwnerReceipt(workers[1], receipt!), false);
          await assertRejects(
            () =>
              ctx.transaction(async (tx) => {
                await tx.collections.records.create({
                  id: "changed",
                  text: "different",
                });
              }, { operationKey: "commit" }),
            Error,
            "another principal, kind or intent",
          );
          assertEquals(await recoverOwnerReceipt(workers[1], receipt!), false);
        }
        await ctx.transaction(async (tx) => {
          await tx.collections.records.create({
            id: "once",
            text: "committed",
          });
        }, { operationKey: "commit" });
        if (executions === 1) {
          assertEquals(await recoverOwnerReceipt(workers[2], receipt!), false);
          selected = "replacement";
          if (mode === "action") failTerminal = true;
          throw new Error("retry this invocation on another admitted worker");
        }
        assertEquals(await recoverOwnerReceipt(workers[1], receipt!), true);
        finished.resolve();
      };
      const action = defineAction({
        id: "replacement.action",
        execute: (_input: unknown, ctx) => mutate(ctx),
      });
      const actions = { mutate: action };
      const processor = defineProcessor({
        id: "replacement.receipt",
        on: [{ eventType: "replacement.request" }],
        async handle(_event, ctx) {
          if (mode === "action") {
            await (ctx.actions.mutate as RuntimeContext["actions"][string])(
              {},
              { operationKey: "nested" },
            );
          } else await mutate(ctx);
        },
      });
      let gateway:
        | Awaited<ReturnType<typeof createCopilotzGateway>>
        | undefined;
      let ownerBinding:
        | Parameters<
          NonNullable<
            NonNullable<
              Parameters<typeof createCopilotzGateway>[0]
            >["dispatcher"]
          >
        >[0]
        | undefined;
      const admit: WorkerCallOptions["admit"] =
        (binding) => async (context) => {
          const call = await readCapability(context.input) as CapabilityCall;
          if (call.kind === "transaction") {
            receipt ??= call.receipt &&
              {
                ...call.receipt,
                intent: JSON.parse(
                  new TextDecoder().decode(
                    encodeCapability({
                      plan: call.plan,
                      options: call.options,
                    }),
                  ),
                ),
              };
            observed.push(binding.fence.identity.workerId);
          }
          const handler = await (binding.parent
            ? ownerBinding?.workerCalls.admit(binding)
            : ownerBinding?.workerCalls.admitUnassigned?.(binding));
          assert(handler);
          return await handler({
            ...context,
            input: new ReadableStream({
              start(controller) {
                controller.enqueue(encodeCapability(call));
                controller.close();
              },
            }),
          });
        };
      const hypervisor = createHypervisor({
        transports: [
          transport === "in-process"
            ? { type: "in-process", config: { topic } }
            : { type: "websocket", config: { path: "/worker" } },
        ],
        ...(transport === "websocket"
          ? {
            admit(context) {
              const workerId = context.identity.workerId;
              assert(
                ["original", "replacement", "unrelated"].includes(workerId),
              );
              assertEquals(context.credential.capability, `test-${workerId}`);
              return {
                definition: {
                  workerId,
                  providerId: "test",
                  workloads: [...context.workloads],
                  capacity: context.capacity,
                  providerConfig: {},
                  labels: {},
                },
                sessionGeneration: 1,
                authenticatedWith: context.credential.kind,
                resume: {
                  credential: {
                    kind: "resume" as const,
                    capability: `resume-${workerId}`,
                  },
                  expiresAtMs: Date.now() + 60000,
                },
              };
            },
          }
          : {}),
        workerCalls: { admit, admitUnassigned: admit },
      }, {
        onDisconnect: (event) =>
          ownerBinding?.lifecycle.onDisconnect?.(event),
        onComplete: (event) => ownerBinding?.lifecycle.onComplete?.(event),
      });
      const listener = transport === "websocket"
        ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
        : undefined;
      const url = listener ? new URL("/worker", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      const workers: Worker[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        gateway = await createCopilotzGateway({
          namespace: "replacement",
          database: {
            ...database,
            transaction<T>(
              run: (
                tx: import("../events/session.ts").SqlExecutor,
              ) => T | Promise<T>,
            ) {
              return database.transaction(async (tx) =>
                await run({
                  async query<Row extends Record<string, unknown>>(
                    sql: string,
                    params?: unknown[],
                  ) {
                    // Model an interrupted terminal commit, not a business failure:
                    // the first Collection command is already durably committed.
                    if (
                      failTerminal &&
                      sql.includes('INSERT INTO "public"."event_bodies"') &&
                      params?.includes("replacement.action.failed")
                    ) {
                      failTerminal = false;
                      terminalFailures++;
                      throw new Error(
                        "injected terminal persistence failure",
                      );
                    }
                    return await tx.query<Row>(sql, params);
                  },
                })
              );
            },
          },
          collections: { records },
          processors: { run: processor },
          actions,
          dispatcher: (binding) => {
            ownerBinding = binding;
            return {
              sessions: hypervisor.sessions,
              dispatch: (input) =>
                hypervisor.dispatch({
                  ...input,
                  target: { workerId: selected },
                }),
            };
          },
          engine: { retryBaseMs: 0, random: () => 0 },
        });
        const registry = createPluginRegistry({
          collections: { records },
          processors: { run: processor },
          actions,
        });
        for (const id of ["original", "replacement", "unrelated"]) {
          const workloads = createOwnerWorkerWorkloads({
            registry,
          });
          const worker = createWorker({
            id,
            transport: transport === "in-process"
              ? { type: "in-process", config: { topic } }
              : {
                type: "websocket",
                config: { url: url!, allowInsecureLoopback: true },
              },
            ...(transport === "websocket"
              ? {
                activate: () => ({
                  workerId: id,
                  attemptId: `attempt-${id}`,
                  epoch: 1,
                }),
                register: () => ({
                  credential: {
                    kind: "registration" as const,
                    capability: `test-${id}`,
                  },
                  expiresAtMs: Date.now() + 60000,
                }),
                reconnectDelay: false as const,
              }
              : {}),
            workloads,
          });
          workers.push(worker);
          await worker.ready;
        }
        const store = createEventStore({ session: database, schema: "public" });
        await store.commitMutation({
          draft: {
            type: "replacement.request",
            namespace: "replacement",
            payload: {},
          },
          ingress: hostIngressProof(),
          consumers: [{
            consumerId: "processor:replacement.receipt",
            settlement: "inherit",
          }],
        });
        await gateway.application.recoverAll({ limit: 100 });
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(async () => {
            reject(
              new Error(
                `replacement did not finish: ${
                  JSON.stringify({
                    executions,
                    observed,
                    terminalFailures,
                    deliveries: (await database.query(
                      "SELECT status,attempts,last_error FROM public.event_deliveries",
                    )).rows,
                  })
                }`,
              ),
            );
          }, 8000);
        });
        await Promise.race([finished.promise, deadline]);
        assertEquals(observed, ["original", "replacement", "replacement"]);
        assertEquals(terminalFailures, mode === "action" ? 1 : 0);
        assertEquals(await recoverOwnerReceipt(workers[0], receipt!), true);
        assertEquals(await recoverOwnerReceipt(workers[2], receipt!), false);
        assertEquals(
          (await database.query(
            "SELECT count(*)::int AS n FROM public.nodes WHERE type='replacement_record'",
          )).rows[0].n,
          1,
        );
        assertEquals(
          (await database.query(
            "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='collections.commit'",
          )).rows[0].n,
          1,
        );
      } finally {
        clearTimeout(timer);
        for (const worker of workers) await worker.stop();
        await gateway?.shutdown();
        await hypervisor.shutdown();
        await listener?.shutdown();
        await database.close();
      }
    });
  }
}
