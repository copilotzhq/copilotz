/** Explicit unpublished-sibling integration. Run with COPILOTZ_OXIAN_SOURCE_ROOT.
 * Exercises real work streams, registered Collections/Processors/Views and owner
 * storage. It does not exercise a public Action or callLlm adapter. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createCoreSchemaStatements } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlSession } from "../events/session.ts";
import { defineCollection } from "../collections/index.ts";
import {
  createPluginRegistry,
  definePlugin,
  defineProcessor,
} from "../plugins/index.ts";
import { createDeliveryExecutor } from "../execution/index.ts";
import { createTestProcessorContext } from "../testing/processor-context.ts";
import { createTextRenderer, defineView } from "../views/index.ts";
import { createOwnerCommandBoundary, type OwnerCommand } from "./boundary.ts";
import { createOwnerCollectionCommand } from "./collections.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import { createOwnerTransactionPlanner } from "./transaction.ts";
import {
  createOwnerConnection,
  createOwnerWorkerCallAdmission,
  type OwnerHostCaller,
  type OwnerWorkerCallContext,
} from "./connection.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(label)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
const notes = defineCollection({
  name: "note",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      namespace: { type: "string" },
      title: { type: "string" },
      privateMemo: { type: "string" },
      createdAt: { type: "string" },
      updatedAt: { type: "string" },
    },
    required: ["id", "namespace", "title", "createdAt", "updatedAt"],
  } as const,
});
const root = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const transportKind of ["in-process", "websocket"]) {
  test(
    `unpublished Oxian ${transportKind}: occupied worker plans Collection writes, replays local values, publishes Processor, renders View and recovers receipt`,
    {
      skip: !root,
      timeout: 30_000,
    },
    async () => {
      const { entrypoints } = await resolveOxianSource(root!);
      const { createHypervisor } = await import(
        entrypoints["./hypervisor"]
      );
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      assert.equal(
        typeof createHypervisor,
        "function",
        "Oxian hypervisor export is unavailable",
      );
      assert.equal(
        typeof createWorker,
        "function",
        "Oxian worker export is unavailable",
      );
      assert.equal(
        typeof serve,
        "function",
        "Oxian Node server export is unavailable",
      );
      const db = await createTestDatabase({
        pgliteMemoryProfile: "low-memory",
      });
      for (const sql of createCoreSchemaStatements("public")) {
        await db.query(sql);
      }
      await provisionOwnerCommandSchema(db, "public");
      const beforeCommit = deferred();
      const releaseCommit = deferred();
      const observed = deferred();
      let gateNextCommit = false;
      let mutationCommitted = false;
      let processorStarts = 0;
      let renderCalls = 0;
      let projectionCalls = 0;
      let viewPrefix = "";
      let planningCalls = 0;
      const submittedPlans: OwnerCommand[] = [];
      const reverseResponses: string[] = [];
      const localOnlyMarker = "LOCAL_CALLBACK_VALUE";
      const observations: {
        eventId: string;
        records: number;
        receipts: number;
        seq: string;
      }[] = [];
      const ownerSession: SqlSession = {
        query: db.query,
        async transaction(operation) {
          let gated = false;
          const result = await db.transaction(async (tx) => {
            const outcome = await operation(tx);
            if (gateNextCommit) {
              gateNextCommit = false;
              gated = true;
              beforeCommit.resolve();
              await releaseCommit.promise;
            }
            return outcome;
          });
          if (gated) mutationCommitted = true;
          return result;
        },
      };
      const processor = defineProcessor({
        id: "owner.notes.observe",
        on: [{ eventType: "note.created" }],
        async handle(event) {
          processorStarts++;
          assert.equal(mutationCommitted, true);
          assert.equal(event.durable, true);
          observations.push({
            eventId: event.id,
            records: (await db.query("SELECT id FROM nodes WHERE type='note'"))
              .rows.length,
            receipts: (await db.query(
              "SELECT key FROM owner_receipts WHERE kind='collections'",
            )).rows.length,
            seq: String(event.durable ? event.seq : undefined),
          });
          if (observations.length === 2) observed.resolve();
        },
      });
      const noteView = defineView({
        id: "owner.notes.context",
        shows: { list: "note" },
        renderer: "text",
        modes: ["context"],
        render(items: readonly { id: string; title: string }[]) {
          renderCalls++;
          for (const item of items) {
            assert.deepEqual(Object.keys(item).sort(), ["id", "title"]);
          }
          return viewPrefix +
            items.map((item) => `${item.id}: ${item.title}`).join("\n");
        },
      });
      const registry = createPluginRegistry({
        plugins: [definePlugin({
          id: "owner-connected-fixture",
          version: "1",
          collections: { notes },
          processors: { observe: processor },
          views: { notes: noteView },
        })],
      });
      const executor = createDeliveryExecutor({
        store: createEventStore({ session: db }),
        registry,
        createContext: createTestProcessorContext,
        workerId: "owner-processor",
      });
      const collections = createOwnerCollectionCommand({
        session: db,
        schema: "public",
        registry,
        collections: { notes },
        executor,
        scope: (context) => ({ namespace: String(context.caller.namespace) }),
      });
      let currentConnection: string | undefined;
      const boundary = createOwnerCommandBoundary({
        session: ownerSession,
        schema: "public",
        ownerId: "owner",
        holderId: "holder",
        handlers: {
          collections,
          // Fixture-only ordinary text. Production receipt payloads and read
          // authorization remain the responsibility of the registered handler.
          render: async (intent, context) => {
            assert.deepEqual(intent, {});
            const renderer = createTextRenderer({
              registry,
              scope: { namespace: context.caller.namespace },
              async project(reference) {
                projectionCalls++;
                assert.deepEqual(reference.shows, { list: "note" });
                const rows = await context.tx.query<
                  { id: string; title: string }
                >(
                  "SELECT id,data->>'title' AS title FROM nodes WHERE type='note' AND namespace=$1 ORDER BY id",
                  [context.caller.namespace],
                );
                return rows.rows.map(({ id, title }) => ({ id, title }));
              },
            });
            return {
              text: await renderer.render(
                { shows: { list: "note" }, value: null },
                {},
                context.signal,
              ),
            };
          },
        },
        authorize(_tx, caller, command) {
          assert.equal(caller.workerId, "worker");
          assert.equal(caller.connectionId, currentConnection);
          assert.equal(caller.invocation, "invocation");
          assert.equal(caller.namespace, "authorized-space");
          assert.equal(
            JSON.stringify(command).includes(localOnlyMarker),
            false,
          );
          assert.ok(
            command.key === `invocation:${command.kind}` ||
              (command.kind === "collections" &&
                command.key === "invocation:change"),
          );
        },
        authenticateReceipt(_tx, caller) {
          assert.equal(caller.workerId, "worker");
        },
      });
      const epoch = await boundary.acquire(0);
      const admission = createOwnerWorkerCallAdmission({
        resolveOwner: (id) => id === "owner" ? boundary : undefined,
        resolveAssignment(context: OwnerWorkerCallContext) {
          assert.equal(context.parent?.metadata.invocation, "invocation");
          currentConnection = context.fence.connectionId;
          return {
            ownerId: "owner",
            ctxGranted: true,
            caller: {
              workerId: context.fence.identity.workerId,
              ownerEpoch: epoch,
              connectionId: context.fence.connectionId,
              invocation: "invocation",
              namespace: "authorized-space",
            },
          };
        },
      });
      const identity = {
        workerId: "worker",
        attemptId: crypto.randomUUID(),
        epoch: 1,
      };
      const local = {
        type: "in-process",
        config: { topic: crypto.randomUUID() },
      };
      const host = createHypervisor({
        transports: transportKind === "in-process"
          ? [local]
          : [{ type: "websocket", config: { path: "/workers" } }],
        workerCalls: {
          ...admission,
          timeoutMs: 3000,
          maxConcurrent: 2,
          maxPerConnection: 2,
        },
        admit: ({ credential }: { credential: { kind: string } }) => ({
          definition: {
            workerId: "worker",
            providerId: "fixture",
            workloads: ["action"],
            capacity: 1,
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
      });
      const listener = transportKind === "websocket"
        ? await serve({ hypervisor: host })
        : undefined;
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      const worker = createWorker({
        id: "worker",
        transport: url
          ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
          : local,
        capacity: 1,
        hostCalls: { maxConcurrent: 2, timeoutMs: 3000 },
        activate: () => identity,
        register: () => ({
          credential: { kind: "registration", capability: "fixture" },
          expiresAtMs: Date.now() + 60_000,
        }),
        reconnectDelay: false,
        workloads: {
          action: async ({ callHost, metadata }: {
            callHost: OwnerHostCaller;
            metadata: Readonly<Record<string, unknown>>;
          }) => {
            // Invocation identity comes from the host's assignment, and the
            // owner independently authorizes it on every reverse command.
            assert.equal(metadata.invocation, "invocation");
            const connection = createOwnerConnection({
              ownerId: "owner",
              async callHost(request) {
                const handle = await callHost(request);
                const decoder = new TextDecoder();
                let response = "";
                return {
                  ...handle,
                  output: handle.output.pipeThrough(
                    new TransformStream<Uint8Array, Uint8Array>({
                      transform(bytes, controller) {
                        response += decoder.decode(bytes, { stream: true });
                        controller.enqueue(bytes);
                      },
                      flush() {
                        reverseResponses.push(response + decoder.decode());
                      },
                    }),
                  ),
                };
              },
            });
            const transaction = createOwnerTransactionPlanner({
              collections: { notes },
              identity: {
                ownerId: "owner",
                workerId: "worker",
                invocationId: metadata.invocation,
              },
              execute(command, options) {
                submittedPlans.push(structuredClone(command));
                return connection.execute(command, options);
              },
            });
            type LocalValue = {
              marker: string;
              fn: () => number;
              ids: Map<string, string[]>;
              self?: LocalValue;
            };
            let localValue: LocalValue | undefined;
            const reversePlan = metadata.reversePlan === true;
            const planned = transaction({
              operationKey: "invocation:collections",
              async execute({ collections }) {
                const callback = ++planningCalls;
                const ids = [];
                for (const id of reversePlan ? ["b", "a"] : ["a", "b"]) {
                  const ref = await collections.notes.create({
                    id,
                    title: `Note ${id}`,
                    privateMemo: `PRIVATE_FIXTURE_${id}`,
                  });
                  assert.deepEqual(ref, { id });
                  ids.push(ref.id);
                }
                localValue = {
                  marker: localOnlyMarker,
                  fn: () => callback,
                  ids: new Map([["planned", ids]]),
                };
                localValue.self = localValue;
                return localValue;
              },
            });
            if (reversePlan) {
              await assert.rejects(planned, { code: "owner_intent_conflict" });
              return new TextEncoder().encode(JSON.stringify({
                conflict: "owner_intent_conflict",
              }));
            }
            const { value, outcome } = await planned;
            assert.equal(value, localValue);
            assert.equal(value.self, value);
            assert.ok(value.ids instanceof Map);
            assert.throws(() => JSON.stringify(value), TypeError);
            assert.equal(value.marker, localOnlyMarker);
            const view = await connection.execute({
              kind: "render",
              domain: "logical",
              key: "invocation:render",
              intent: {},
            });
            // Only explicit ordinary observations cross the workload stream.
            // The cyclic callback T remains the exact worker-local object.
            return new TextEncoder().encode(JSON.stringify({
              outcome,
              view,
              local: { callback: value.fn(), ids: value.ids.get("planned") },
            }));
          },
        },
      });
      try {
        await worker.ready;
        assert.equal(
          typeof worker.callHost,
          "function",
          "Selected Oxian source lacks reverse worker calls",
        );
        let committedResult: unknown;
        for (const status of ["committed", "duplicate"]) {
          gateNextCommit = status === "committed";
          const handle = await host.dispatch({
            workload: "action",
            metadata: { invocation: "invocation" },
            deadlineAtMs: Date.now() + 5000,
          });
          let outputSettled = false;
          const output = new Response(handle.output).text().then((value) => {
            outputSettled = true;
            return JSON.parse(value);
          });
          if (status === "committed") {
            await within(
              beforeCommit.promise,
              "Owner did not reach commit gate",
            );
            assert.equal(mutationCommitted, false);
            assert.equal(outputSettled, false);
            assert.equal(processorStarts, 0);
            releaseCommit.resolve();
          }
          const reply = await output;
          assert.equal(reply.outcome.status, status);
          assert.deepEqual(reply.local, {
            callback: status === "committed" ? 1 : 2,
            ids: ["a", "b"],
          });
          assert.equal(planningCalls, status === "committed" ? 1 : 2);
          assert.equal(reply.view.status, status);
          assert.deepEqual(reply.view.result, { text: "a: Note a\nb: Note b" });
          assert.equal(
            JSON.stringify(reply).includes("PRIVATE_FIXTURE"),
            false,
          );
          assert.equal(projectionCalls, 1);
          assert.equal(renderCalls, 1);
          assert.deepEqual(reply.outcome.result.recordIds, ["a", "b"]);
          assert.equal(reply.outcome.result.eventIds.length, 2);
          assert.equal(
            JSON.stringify(reply.outcome.result).includes("title"),
            false,
          );
          if (status === "committed") committedResult = reply.outcome.result;
          else assert.deepEqual(reply.outcome.result, committedResult);
          assert.equal((await handle.completed).status, "completed");
          if (status === "committed") {
            await within(
              observed.promise,
              "Processors did not observe initial commit",
            );
            // Change durable source data and View behavior between attempts.
            // The same command identity must recover captured text unchanged.
            await boundary.execute({
              workerId: "worker",
              ownerEpoch: epoch,
              connectionId: currentConnection,
              invocation: "invocation",
              namespace: "authorized-space",
            }, {
              kind: "collections",
              domain: "logical",
              key: "invocation:change",
              intent: {
                operations: [{
                  collection: "notes",
                  operation: "update",
                  input: { id: "a", set: { title: "Changed note a" } },
                }],
              },
            });
            viewPrefix = "replacement View: ";
          }
        }
        assert.deepEqual(submittedPlans[1], submittedPlans[0]);
        const snapshot = async () => ({
          nodes: (await db.query("SELECT * FROM nodes ORDER BY id")).rows,
          events: (await db.query("SELECT * FROM events ORDER BY seq")).rows,
          receipts:
            (await db.query("SELECT * FROM owner_receipts ORDER BY key"))
              .rows,
          epochs: (await db.query("SELECT * FROM owner_epochs ORDER BY owner"))
            .rows,
          processorStarts,
          projectionCalls,
          renderCalls,
        });
        const beforeConflict = await snapshot();
        const changed = await host.dispatch({
          workload: "action",
          metadata: { invocation: "invocation", reversePlan: true },
          deadlineAtMs: Date.now() + 5000,
        });
        assert.deepEqual(await new Response(changed.output).json(), {
          conflict: "owner_intent_conflict",
        });
        assert.equal((await changed.completed).status, "completed");
        assert.equal(planningCalls, 3);
        assert.equal(submittedPlans.length, 3);
        const initialIntent = submittedPlans[0].intent as {
          operations: unknown[];
        };
        assert.deepEqual(submittedPlans[2], {
          ...submittedPlans[0],
          intent: { operations: [...initialIntent.operations].reverse() },
        });
        assert.deepEqual(await snapshot(), beforeConflict);
        assert.equal(
          JSON.stringify(submittedPlans).includes(localOnlyMarker),
          false,
        );
        assert.equal(
          JSON.stringify(beforeConflict.receipts).includes(localOnlyMarker),
          false,
        );
        assert.equal(reverseResponses.length, 5);
        for (const response of reverseResponses) {
          assert.equal(response.includes(localOnlyMarker), false);
          assert.equal(response.includes("PRIVATE_FIXTURE"), false);
        }
        await within(
          observed.promise,
          "Registered Processors did not observe committed notes",
        );
        assert.deepEqual(observations.map((entry) => entry.records), [2, 2]);
        assert.deepEqual(observations.map((entry) => entry.receipts), [1, 1]);
        assert.deepEqual(observations.map((entry) => entry.seq).sort(), [
          "1",
          "2",
        ]);
        assert.deepEqual(
          (await db.query(
            "SELECT id,namespace,data->>'title' AS title FROM nodes WHERE type='note' ORDER BY id",
          )).rows,
          [
            { id: "a", namespace: "authorized-space", title: "Changed note a" },
            { id: "b", namespace: "authorized-space", title: "Note b" },
          ],
        );
        const events = await db.query(
          "SELECT id,type,owner_id,seq FROM events ORDER BY seq",
        );
        assert.deepEqual(events.rows.map((row) => String(row.seq)), [
          "1",
          "2",
          "3",
        ]);
        assert.deepEqual(events.rows.map((row) => row.owner_id), [
          "owner",
          "owner",
          "owner",
        ]);
        assert.deepEqual(
          observations.map((entry) => entry.eventId).sort(),
          events.rows.filter((row) => row.type === "note.created").map((row) =>
            row.id
          ).sort(),
        );
        assert.equal(
          String(
            (await db.query("SELECT last_seq FROM owner_epochs")).rows[0]
              .last_seq,
          ),
          "3",
        );
        const recovery = createOwnerConnection({
          ownerId: "owner",
          callHost: worker.callHost,
        });
        assert.deepEqual(
          await recovery.readReceipt({
            domain: "logical",
            key: "invocation:collections",
          }),
          { kind: "collections", result: committedResult },
        );
        await assert.rejects(
          recovery.execute({
            kind: "collections",
            domain: "logical",
            key: "forged",
            intent: {},
          }),
        );
      } finally {
        releaseCommit.resolve();
        await worker.stop();
        await host.shutdown();
        await listener?.shutdown();
        boundary.stop();
        await executor.shutdown();
        await db.close();
      }
    },
  );
}
