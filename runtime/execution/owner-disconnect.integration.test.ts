import { hostIngressProof } from "../application/ingress/authority.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext, RuntimeContext } from "../actions/types.ts";
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

for (
  const boundary of [
    "commit-reply",
    "begun-effect",
    "cancel-after-disconnect",
  ] as const
) {
  for (
    const transport of ["websocket"] as readonly ("in-process" | "websocket")[]
  ) {
    Deno.test(`${transport}: physical disconnect at ${boundary} preserves logical replay and effect authority`, async () => {
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
      let selected = "original", executions = 0, dispatches = 0;
      let originalSocket: WebSocket | undefined;
      let physicalDisconnects = 0;
      const finished = Promise.withResolvers<void>();
      const disconnected = Promise.withResolvers<void>();
      const cancelCommitted = Promise.withResolvers<void>();
      const lateWorker = Promise.withResolvers<void>();
      const lateWorkerReturned = Promise.withResolvers<void>();

      let receipt: NonNullable<CapabilityCall["receipt"]> | undefined;
      const observed: string[] = [];
      const mutate = async (
        ctx: Pick<RuntimeContext, "transaction" | "signal">,
      ) => {
        executions++;
        if (boundary === "begun-effect") {
          const action = ctx as ActionContext;
          assertEquals(await action.effect.begin("external-send"), {
            status: "proceed",
          });
          dispatches++;
          selected = "replacement";
          assert(originalSocket);
          originalSocket.close(4001, "test interrupted provider result");
          if (!ctx.signal.aborted) {
            await new Promise<void>((resolve) => {
              ctx.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          }
          // A late external response is deliberately not confirmation authority.
          await assertRejects(() =>
            action.effect.confirm("external-send", { sent: true })
          );
          throw ctx.signal.reason;
        }
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
        try {
          await ctx.transaction(async (tx) => {
            await tx.collections.records.create({
              id: "once",
              text: "committed",
            });
          }, { operationKey: "commit" });
        } catch (error) {
          if (boundary !== "cancel-after-disconnect") throw error;
          await lateWorker.promise;
          lateWorkerReturned.resolve();
          return; // Deliberate stale worker success after durable cancellation.
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
          await (ctx.actions.mutate as RuntimeContext["actions"][string])(
            {},
            { operationKey: "nested" },
          );
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
          const result = await handler({
            ...context,
            input: new ReadableStream({
              start(controller) {
                controller.enqueue(encodeCapability(call));
                controller.close();
              },
            }),
          });
          if (
            call.kind === "transaction" &&
            binding.fence.identity.workerId === "original"
          ) {
            assert(originalSocket);
            selected = "replacement";
            // Close the actual native socket after the owner's transaction
            // committed, before any response body reaches the original worker.
            // No protocol Cancel/Error or synthetic persistence failure.
            originalSocket.close(4001, "test transport loss");
            if (!binding.signal.aborted) {
              await new Promise<void>((resolve) => {
                binding.signal.addEventListener("abort", () =>
                  resolve(), { once: true });
              });
            }
            throw binding.signal.reason;
          }
          return result;
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
        onDisconnect: (event) => {
          physicalDisconnects++;
          const retired = ownerBinding?.lifecycle.onDisconnect?.(event);
          disconnected.resolve();
          return retired;
        },
        onComplete: (event) =>
          ownerBinding?.lifecycle.onComplete?.(event),
      });
      const listener = transport === "websocket"
        ? listen({ hypervisor }, { hostname: "127.0.0.1", port: 0 })
        : undefined;
      const url = listener ? new URL("/worker", listener.url) : undefined;
      if (url) {
        url.protocol = "ws:";
      }
      const workers: Worker[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        gateway = await createCopilotzGateway({
          namespace: "replacement",
          database,
          collections: { records },
          processors: { run: processor },
          actions,
          dispatcher: (binding) => {
            ownerBinding = binding;
            return {
              sessions: hypervisor.sessions,
              dispatch: async (input) => {
                if (
                  boundary === "cancel-after-disconnect" &&
                  selected === "replacement"
                ) {
                  await cancelCommitted.promise;
                }
                return await hypervisor.dispatch({
                  ...input,
                  target: { workerId: selected },
                });
              },
            };
          },
          engine: {
            retryBaseMs: 0,
            random: () =>
              0,
          },
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
                config: {
                  url: url!,
                  allowInsecureLoopback: true,
                  socket: ({ url, protocol }) => {
                    const socket = new WebSocket(url, protocol);
                    if (id === "original") originalSocket = socket;
                    return socket;
                  },
                },
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
        let operationId: string | undefined;
        if (boundary === "cancel-after-disconnect") {
          const sent = await gateway.send({
            type: "replacement.request",
            payload: {},
          });
          operationId = sent.eventId;
          void sent.done.catch(() => undefined);
          await sent.outputs.cancel();
        } else {
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
        }
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(async () => {
            reject(
              new Error(
                `replacement did not finish: ${
                  JSON.stringify({
                    executions,
                    observed,
                    physicalDisconnects,
                    deliveries: (await database.query(
                      "SELECT status,attempts,last_error FROM public.event_deliveries",
                    )).rows,
                  })
                }`,
              ),
            );
          }, 8000);
        });
        if (boundary === "cancel-after-disconnect") {
          await Promise.race([disconnected.promise, deadline]);
          assert(operationId);
          const result = await gateway.cancelOperation({
            operationId,
            reason: "explicit caller cancellation",
          });
          assertEquals(result?.state, "cancelled");
          cancelCommitted.resolve();
          lateWorker.resolve();
          await Promise.race([lateWorkerReturned.promise, deadline]);
          await new Promise((resolve) => setTimeout(resolve, 20));
          assertEquals(executions, 1);
          assertEquals(
            (await database.query(
              "SELECT count(*)::int AS n FROM public.open_actions",
            )).rows[0].n,
            0,
          );
          assertEquals(
            (await database.query(
              "SELECT type FROM public.events WHERE type IN ('replacement.action.completed','replacement.action.failed','replacement.action.cancelled')",
            )).rows,
            [{ type: "replacement.action.cancelled" }],
          );
          assertEquals(
            (await database.query(
              "SELECT status FROM public.event_deliveries WHERE consumer_id='processor:replacement.receipt'",
            )).rows,
            [{ status: "cancelled" }],
          );
          return;
        }
        if (boundary === "begun-effect") {
          await Promise.race([
            (async () => {
              for (;;) {
                const rows = (await database.query(
                  "SELECT status,last_error FROM public.event_deliveries WHERE consumer_id='processor:replacement.receipt'",
                )).rows;
                if (rows.some((row) => row.status === "dead_letter")) {
                  assertEquals(
                    (rows[0].last_error as { code: string }).code,
                    "effect_indeterminate",
                  );
                  return;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            })(),
            deadline,
          ]);
          assertEquals(executions, 1);
          assertEquals(dispatches, 1);
          assertEquals(
            (await database.query("SELECT status FROM public.action_effects"))
              .rows,
            [{ status: "begun" }],
          );
          assertEquals(physicalDisconnects, 1);
          return;
        }
        await Promise.race([finished.promise, deadline]);
        assertEquals(observed, ["original", "replacement", "replacement"]);
        assertEquals(physicalDisconnects, 1);
        assertEquals(executions, 2);
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
        cancelCommitted.resolve();
        lateWorker.resolve();
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
