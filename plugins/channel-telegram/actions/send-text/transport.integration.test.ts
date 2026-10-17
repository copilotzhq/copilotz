/** Opt-in real transport proof using the explicit unpublished Oxian sibling.
 * All Telegram traffic uses injected fetch; this is not public HTTP egress.
 * Faults occur after a known owner command commit, before its reply; they do
 * not simulate uncertain database COMMIT or prove restarted-host recovery. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnerHost } from "../../../../runtime/application/owner-host.ts";
import { createOwnerConnectedWorker } from "../../../../runtime/application/owner-worker.ts";
import { createActionLifecycleLoader } from "../../../../runtime/actions/persistence.ts";
import { createEventStore } from "../../../../runtime/events/store.ts";
import { createOwnerConnection } from "../../../../runtime/owner/connection.ts";
import { encodeOwnerMetadataConstraints } from "../../../../runtime/owner/metadata-constraints.ts";
import { createPluginRegistry } from "../../../../runtime/plugins/registry.ts";
import { createTestDatabase } from "../../../../runtime/testing/ominipg.ts";
import { resolveOxianSource } from "../../../../scripts/test-owner-connected.mjs";
import {
  TELEGRAM_SEND_TEXT_ACTION_ID,
  TELEGRAM_SEND_TEXT_STEP,
  telegramSendTextAction,
} from "./index.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Telegram transport fixture timed out")),
          12_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function eventually(check: () => Promise<boolean>) {
  await within((async () => {
    while (!await check()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  })());
}
const root = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  for (
    const loss of ["none", "begin", "provider", "confirm", "terminal"] as const
  ) {
    test(
      `Telegram actual ${mode}: ${
        loss === "none"
          ? "duplicates and next send"
          : loss === "provider"
          ? "injected provider acceptance then disconnect before confirm"
          : `lost ${loss} reply after known commit`
      } preserve dispatch authority`,
      { skip: !root, timeout: 30_000 },
      async () => {
        const { entrypoints } = await resolveOxianSource(root!);
        const { createHypervisor } = await import(entrypoints["./hypervisor"]);
        const { createWorker } = await import(entrypoints["./worker"]);
        const { serve } = await import(entrypoints["./adapters/node"]);
        const db = await createTestDatabase({
          pgliteMemoryProfile: "low-memory",
        });
        const registry = createPluginRegistry({
          actions: { telegramSendText: telegramSendTextAction },
        });
        const local = {
          type: "in-process" as const,
          config: { topic: crypto.randomUUID() },
        };
        const workerStop = new AbortController();
        const dropped = deferred();
        const errors: unknown[] = [];
        let sends = 0;
        let armed = loss !== "none";
        const host = await createOwnerHost({
          ownerId: "owner",
          holderId: "holder",
          schema: "public",
          session: db,
          initialization: "fresh",
          registry,
          maxActive: 1,
          maxPending: 8,
          onError: (error) => errors.push(error),
          policy: {
            ingress: (_tx, input) =>
              input.fence.identity.workerId === "ingress"
                ? {
                  namespace: "space",
                  principalKey: "api:fixture",
                  principal: { actorId: "api:fixture" },
                  route: { kind: "wrapper", id: "telegram-fixture" },
                  allowedActions: ["telegramSendText"],
                  actionMetadata: {},
                  operationMetadata: { tenant: "space" },
                  metadataConstraints: encodeOwnerMetadataConstraints({
                    tenant: "space",
                    actorId: "api:fixture",
                  }),
                  group: { key: "fixture", actorId: "api:fixture" },
                }
                : undefined,
            worker: (_tx, input) =>
              ["action", "ingress"].includes(input.fence.identity.workerId)
                ? { ctx: true, settlement: true }
                : undefined,
            input(_tx, assignment) {
              assert.equal(assignment.actionId, TELEGRAM_SEND_TEXT_ACTION_ID);
            },
            collections: () => ({}),
            effectOutcome(_tx, assignment, ref, outcome) {
              assert.equal(assignment.actionId, TELEGRAM_SEND_TEXT_ACTION_ID);
              assert.equal(ref.step, TELEGRAM_SEND_TEXT_STEP);
              assert.equal(ref.namespace, "space");
              return !!outcome && typeof outcome === "object" &&
                !Array.isArray(outcome) &&
                Object.keys(outcome).sort().join(",") ===
                  "deliveryKey,providerId";
            },
            effectNotStarted: () => false,
          },
          transport: {
            transports: mode === "in-process"
              ? [local]
              : [{ type: "websocket", config: { path: "/workers" } }],
            admit: ({ identity, credential, workloads, capacity }) => ({
              definition: {
                workerId: identity.workerId,
                providerId: "fixture",
                workloads,
                capacity,
                providerConfig: {},
                labels: {},
              },
              sessionGeneration: 1,
              authenticatedWith: credential.kind,
              resume: {
                credential: { kind: "resume", capability: "fixture" },
                expiresAtMs: Date.now() + 60_000,
              },
            }),
          },
          createTransport(options, lifecycle) {
            const calls = options.workerCalls;
            return createHypervisor({
              ...options,
              workerCalls: {
                ...calls,
                async admit(context: Parameters<typeof calls.admit>[0]) {
                  const handler = await calls.admit(context);
                  if (!handler) return undefined;
                  return async (input: Parameters<typeof handler>[0]) => {
                    const output = await handler(input);
                    const response = JSON.parse(
                      new TextDecoder().decode(output),
                    );
                    const matching = loss === "begin"
                      ? context.workload === "copilotz.owner.command" &&
                        response?.value?.result?.status === "begun"
                      : loss === "confirm"
                      ? context.workload === "copilotz.owner.effect-settle"
                      : loss === "terminal" &&
                        context.workload === "copilotz.owner.complete";
                    if (armed && response.ok === true && matching) {
                      armed = false;
                      // The command is durably complete; do not release its encoded
                      // reply until the actual worker session has disconnected.
                      workerStop.abort(
                        new Error("injected transport loss after commit"),
                      );
                      await new Promise<void>((resolve) => {
                        if (context.signal.aborted) resolve();
                        else {context.signal.addEventListener("abort", () =>
                            resolve(), { once: true });}
                      });
                      dropped.resolve();
                    }
                    return output;
                  };
                },
              },
            }, lifecycle);
          },
        });
        const listener = mode === "websocket"
          ? await serve({ hypervisor: host.listener })
          : undefined;
        const url = listener ? new URL("/workers", listener.url) : undefined;
        if (url) url.protocol = "ws:";
        const workerOptions = (id: string) => ({
          id,
          transport: url
            ? {
              type: "websocket",
              config: { url, allowInsecureLoopback: true },
            }
            : local,
          capacity: 1,
          hostCalls: { maxConcurrent: 8, timeoutMs: 5000 },
          activate: () => ({
            workerId: id,
            attemptId: crypto.randomUUID(),
            epoch: 1,
          }),
          register: () => ({
            credential: { kind: "registration", capability: "fixture" },
            expiresAtMs: Date.now() + 60_000,
          }),
          reconnectDelay: false,
        });
        const worker = createOwnerConnectedWorker({
          ownerId: "owner",
          namespace: "space",
          registry,
          worker: {
            ...workerOptions("action"),
            signal: workerStop.signal,
          } as never,
          createCapabilities: () => ({
            resources: { channels: { telegram: { egress: "external" } } },
            adapters: {
              channelProviders: {
                telegram: {
                  config: { botToken: "fixture-only" },
                  fetch: (() => {
                    sends++;
                    if (armed && loss === "provider") {
                      armed = false;
                      // This injected provider has accepted one request. Lose
                      // the actual connection before its success is returned
                      // to the Action, so no confirmation can be submitted.
                      workerStop.abort(
                        new Error(
                          "injected provider acceptance before disconnect",
                        ),
                      );
                      dropped.resolve();
                    }
                    return Promise.resolve(
                      Response.json({
                        ok: true,
                        result: {
                          message_id: sends,
                          text: "not-in-effect-receipt",
                        },
                      }),
                    );
                  }) as typeof fetch,
                },
              },
            },
          }),
        }, createWorker);
        const ingress = createWorker({
          ...workerOptions("ingress"),
          workloads: { unused: () => new Uint8Array() },
        });
        try {
          await within(Promise.all([worker.ready, ingress.ready]));
          const connection = createOwnerConnection({
            ownerId: "owner",
            callHost: ingress.callHost,
          });
          const request = {
            actionAlias: "telegramSendText",
            operationKey: "delivery",
            input: {
              deliveryKey: "delivery",
              channelId: "telegram",
              chatId: "123",
              text: "Hello",
            },
          };
          const admitted = await within(connection.callAction(request));
          if (loss === "none") {
            await eventually(async () =>
              (await connection.actionResult(admitted.result) as {
                status: string;
              }).status === "completed"
            );
            assert.deepEqual(await connection.actionResult(admitted.result), {
              status: "completed",
              output: { deliveryKey: "delivery", providerId: "1" },
            });
            assert.equal(
              (await connection.callAction(request)).status,
              "duplicate",
            );
            assert.equal(sends, 1);
            await eventually(() =>
              Promise.resolve(host.snapshot().active === 0)
            );
            const next = await connection.callAction({
              ...request,
              operationKey: "next",
              input: { ...request.input, deliveryKey: "next" },
            });
            await eventually(async () =>
              (await connection.actionResult(next.result) as {
                status: string;
              }).status === "completed"
            );
            assert.equal(sends, 2);
            assert.deepEqual(errors, []);
          } else {
            await within(dropped.promise);
            await eventually(() =>
              Promise.resolve(host.snapshot().recoveryRequired)
            );
            // The fresh-only host conservatively retires after any opened work
            // transport failure. Even a durable terminal does not make result
            // recovery available until host recovery is implemented.
            await assert.rejects(within(connection.callAction(request)));
            await assert.rejects(
              within(connection.actionResult(admitted.result)),
            );
            await worker.close();
            await eventually(() =>
              Promise.resolve(host.snapshot().active === 0)
            );
            assert.equal(sends, loss === "begin" ? 0 : 1);
            assert.equal(armed, false);
            const terminals = (await db.query<
              {
                result: {
                  status: string;
                  executionId: string;
                  deliveryId: string;
                  dispatchAttemptId: string;
                };
              }
            >(
              "SELECT result FROM owner_receipts WHERE kind='execution.complete'",
            )).rows;
            assert.equal(terminals.length, loss === "terminal" ? 1 : 0);
            if (loss === "terminal") {
              assert.equal(terminals[0].result.status, "completed");
              assert.deepEqual(Object.keys(terminals[0].result).sort(), [
                "deliveryId",
                "dispatchAttemptId",
                "executionId",
                "status",
              ]);
              // Fixture-only durable inspection, not a currently admitted
              // result route after the fresh host has stopped.
              const terminal = await createActionLifecycleLoader({
                store: createEventStore({ session: db }),
              })("space", `${terminals[0].result.executionId}:action:terminal`);
              assert.equal(terminal?.status, "completed");
              assert(terminal && terminal.status === "completed");
              assert.deepEqual(terminal.output, {
                deliveryKey: "delivery",
                providerId: "1",
              });
            }
          }
          const effectRows = (await db.query<{ kind: string; result: unknown }>(
            "SELECT kind,result FROM owner_receipts WHERE kind IN ('effect.begin','effect.confirm','effect.notStarted') ORDER BY kind",
          )).rows;
          assert.equal(
            effectRows.filter((row) => row.kind === "effect.begin").length,
            loss === "none" ? 2 : 1,
          );
          assert.equal(
            effectRows.filter((row) => row.kind === "effect.confirm").length,
            loss === "begin" || loss === "provider"
              ? 0
              : loss === "none"
              ? 2
              : 1,
          );
          assert.equal(
            effectRows.filter((row) => row.kind === "effect.notStarted").length,
            0,
          );
          assert.equal(
            JSON.stringify(effectRows).includes("not-in-effect-receipt"),
            false,
          );
          const attempts = (await db.query<
            { attempts: number; max_attempts: number; status: string }
          >(
            "SELECT attempts,max_attempts,status FROM event_deliveries WHERE consumer_id=$1",
            [`registered:${TELEGRAM_SEND_TEXT_ACTION_ID}`],
          )).rows;
          assert.ok(attempts.length >= 1);
          for (const item of attempts) {
            assert.equal(item.attempts, 1);
            assert.equal(item.max_attempts, 3);
            assert.equal(
              item.status,
              loss === "begin" || loss === "provider" || loss === "confirm"
                ? "leased"
                : "succeeded",
            );
          }
        } finally {
          workerStop.abort();
          await worker.close();
          await ingress.stop();
          await host.close();
          await listener?.shutdown();
          await db.close();
        }
      },
    );
  }
}
