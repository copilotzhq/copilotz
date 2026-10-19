import { assert, assertEquals, assertExists } from "@std/assert";
import {
  type ActionCallers,
  type ActionContext,
  createCopilotz,
  defineAction,
  defineCollection,
  definePlugin,
  defineProcessor,
  type ProcessorContext,
} from "../../index.ts";
import { listen } from "../adapters/deno/listen.ts";
import { serverPlugin } from "../../plugins/server/plugin.ts";
import { defineServerFacade } from "../../server/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

const selected = Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL");
const namespace = "retained-space";
const databaseSchema = "retained_graph";

async function eventually<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

for (const mode of ["in-process", "websocket"] as const) {
  Deno.test({
    name:
      `PostgreSQL public ${mode} Collection Processor captured child graph survives three owner openings`,
    ignore: !selected,
    async fn() {
      assert(selected);
      const url = new URL(selected);
      assert(["postgres:", "postgresql:"].includes(url.protocol));
      assertEquals(Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"), selected);
      const admin = await createTestDatabase({ url: url.href, pgPoolMax: 1 });
      const databaseName = `retained_graph_${
        crypto.randomUUID().replaceAll("-", "")
      }`;
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      url.pathname = `/${databaseName}`;
      const inspect = await createTestDatabase({ url: url.href, pgPoolMax: 1 });
      const counts = { roots: 0, processors: 0, preparations: 0, children: 0 };
      const outputs: unknown[] = [];
      const claims: { opening: number; deliveryId: string; token: string }[] =
        [];
      const closers: (() => Promise<void>)[] = [];
      let allowed = true;
      let authorizations = 0;
      let opening = 0;
      const records = defineCollection({
        name: "retained_record",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            namespace: { type: "string" },
            value: { type: "string" },
          },
          required: ["id", "namespace", "value"],
        } as const,
      });
      const results = defineCollection({
        name: "retained_result",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            namespace: { type: "string" },
            value: { type: "string" },
          },
          required: ["id", "namespace", "value"],
        } as const,
      });
      const collections = { records, results };
      async function start() {
        const ordinal = ++opening;
        const revision = ordinal === 1 ? "original" : `replacement-${ordinal}`;
        const database = await createTestDatabase({
          url: url.href,
          pgPoolMax: 4,
        });
        const resources: (() => Promise<unknown>)[] = [() => database.close()];
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          const failures: unknown[] = [];
          for (const closeResource of resources.reverse()) {
            try {
              await closeResource();
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              "Retained graph fixture cleanup failed",
            );
          }
        };
        closers.push(close);
        const child = defineAction({
          id: "retained.child",
          async execute(
            input: { id: string; value: string; revision: string },
            context: ActionContext,
          ) {
            counts.children++;
            const value = `${input.revision}:${input.value}`;
            await context.collections.results.create({
              id: `result:${input.id}`,
              value,
            }, {
              operationKey: "child-result",
            });
            return { id: input.id, value };
          },
        });
        const write = defineAction({
          id: "retained.write",
          async execute(
            input: { id: string; value: string },
            context: ActionContext,
          ) {
            counts.roots++;
            await context.collections.records.create(input, {
              operationKey: "root-record",
            });
            return `accepted:${input.id}`;
          },
        });
        const actions = { write, child };
        const processors = {
          captured: defineProcessor<
            ProcessorContext<
              Record<string, never>,
              Record<string, never>,
              ActionCallers<typeof actions>
            >
          >({
            id: "retained.capture",
            on: [{ eventType: "retained_record.created" }],
            // Parent work is durable and independent of the root's terminal result.
            settlement: "detached",
            async handle(event, context) {
              counts.processors++;
              assert(event.durable);
              // Read-only test observer on a separate connection: the actual
              // claimed row must precede all public handler capabilities.
              const claimed = (await inspect.query<
                {
                  id: string;
                  lease_owner: string;
                  owner_epoch: string;
                  status: string;
                }
              >(
                `SELECT id,lease_owner,owner_epoch,status FROM "${databaseSchema}".event_deliveries WHERE event_id=$1 AND consumer_id='processor:retained.capture'`,
                [event.id],
              )).rows;
              assertEquals(claimed.length, 1);
              assertEquals(claimed[0].status, "leased");
              assertEquals(Number(claimed[0].owner_epoch), ordinal);
              assert(
                typeof claimed[0].lease_owner === "string" &&
                  claimed[0].lease_owner.length > 0,
              );
              claims.push({
                opening: ordinal,
                deliveryId: claimed[0].id,
                token: claimed[0].lease_owner,
              });
              const id = (event.data as { record: { id: string } }).record.id;
              const output = await context.actions.child.prepare(async () => {
                counts.preparations++;
                const record = await context.collections.records.get({ id });
                assertExists(record);
                assert(typeof record.value === "string");
                return { input: { id, value: record.value, revision } };
              }, { operationKey: "first-capture" });
              outputs.push(structuredClone(output));
              if (ordinal === 1) {
                throw new Error(
                  "retained parent interrupted after durable child result",
                );
              }
            },
          }),
        };
        const local = {
          type: "in-process" as const,
          config: { topic: crypto.randomUUID() },
        };
        const socket = {
          type: "websocket" as const,
          config: { path: "/workers" },
        };
        const workerId = `retained-worker-${ordinal}`;
        const credential = crypto.randomUUID();
        const expiresAtMs = Date.now() + 60_000;
        const gateway = await createCopilotz({
          role: "gateway",
          namespace,
          databaseSchema,
          database,
          actions,
          collections,
          processors,
          plugins: [definePlugin({
            ...serverPlugin,
            resources: {
              server: {
                default: defineServerFacade({
                  expose: {
                    actions: { include: [write.id] },
                    collections: false,
                    channels: false,
                  },
                  authenticate: () => ({ actor: { id: "retained-reader" } }),
                  authorize() {
                    authorizations++;
                    return allowed ? {} : Response.json({
                      error: { code: "forbidden", message: "Forbidden" },
                    }, { status: 403 });
                  },
                }),
              },
            },
          })],
          transports: [mode === "in-process" ? local : socket],
          target: { workerId },
          admit(context) {
            assertEquals(context.identity.workerId, workerId);
            assertEquals(context.credential.capability, credential);
            return {
              definition: {
                workerId,
                providerId: "retained-fixture",
                workloads: [...context.workloads],
                capacity: context.capacity,
                providerConfig: {},
                labels: {},
              },
              sessionGeneration: ordinal,
              authenticatedWith: context.credential.kind,
              resume: {
                credential: { kind: "resume", capability: credential },
                expiresAtMs,
              },
            };
          },
          engine: {
            retryBaseMs: 0,
            random: () => 0,
            // Stop the first genuine retry at a durable boundary, rather than
            // manufacturing an invoked child or altering its lifecycle rows.
            ...(ordinal === 1
              ? {
                alarmScheduler: {
                  schedule: (callback: () => void) => callback,
                  cancel() {},
                },
              }
              : {}),
          },
        });
        resources.push(() => gateway.close());
        const listener = mode === "websocket"
          ? listen(gateway, { hostname: "127.0.0.1", port: 0 })
          : undefined;
        if (listener) resources.push(() => listener.shutdown());
        const workerUrl = listener
          ? new URL(socket.config.path, listener.url)
          : undefined;
        if (workerUrl) workerUrl.protocol = "ws:";
        const worker = await createCopilotz({
          role: "worker",
          namespace,
          databaseSchema,
          id: workerId,
          actions,
          collections,
          processors,
          capacity: 4,
          transport: workerUrl
            ? {
              type: "websocket",
              config: { url: workerUrl, allowInsecureLoopback: true },
            }
            : local,
          activate: () => ({
            workerId,
            attemptId: crypto.randomUUID(),
            epoch: ordinal,
          }),
          register: () => ({
            credential: {
              kind: "registration" as const,
              capability: credential,
            },
            expiresAtMs,
          }),
          reconnectDelay: false,
        });
        resources.push(() => worker.close());
        await worker.ready;
        return { gateway, close };
      }
      type Opened = Awaited<ReturnType<typeof start>>;
      let current: Opened | undefined;
      const query = <
        T extends Record<string, unknown> = Record<string, unknown>,
      >(
        sql: string,
        values?: unknown[],
      ) => inspect.query<T>(sql, values);
      const rows = async (table: string, order: string) =>
        (await query(
          `SELECT * FROM "${databaseSchema}".${table} ORDER BY ${order}`,
        )).rows;
      const immutable = async () => ({
        events: await rows("events", "seq"),
        bodies: await rows("event_bodies", "namespace,event_body_id"),
        receipts: await rows("owner_receipts", "owner,domain,key"),
        nodes: await rows("nodes", "namespace,id"),
        sequence: (await rows("events", "seq")).map(({ id, seq }) => ({
          event_id: id,
          sequence: seq,
        })),
      });
      const epoch = async () =>
        Number(
          (await query<{ epoch: string }>(
            `SELECT epoch FROM "${databaseSchema}".owner_epochs WHERE owner='schema'`,
          )).rows[0].epoch,
        );
      const submit = (
        app: Opened,
        input: { id: string; value: string },
        key: string,
      ) =>
        app.gateway.fetch(
          new Request("http://retained.test/api/actions/retained/write", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": key,
            },
            body: JSON.stringify(input),
          }),
        );
      const result = (app: Opened, operationId: string) =>
        app.gateway.fetch(
          new Request(
            `http://retained.test/api/operations/${operationId}/result`,
          ),
        );
      async function accepted(
        app: Opened,
        input: { id: string; value: string },
        key: string,
      ) {
        const response = await submit(app, input, key);
        assertEquals(response.status, 202, await response.clone().text());
        const operationId = (await response.json()).data.operationId as string;
        const completed = await eventually(async () => {
          const response = await result(app, operationId);
          return response.status === 202 ? undefined : response;
        }, `root result ${key}`);
        assertEquals(completed.status, 200, await completed.clone().text());
        assertEquals((await completed.json()).data, `accepted:${input.id}`);
        return operationId;
      }
      async function settled() {
        await eventually(async () => {
          const unsettled = await query(
            `SELECT id,status FROM "${databaseSchema}".event_deliveries WHERE status <> 'succeeded'`,
          );
          const open = await query(
            `SELECT action_run_id FROM "${databaseSchema}".open_actions`,
          );
          const operations = await query(
            `SELECT operation_id,state FROM "${databaseSchema}".copilotz_operations WHERE state <> 'completed'`,
          );
          const deadlines = await query(
            `SELECT source,key FROM "${databaseSchema}".owner_deadlines`,
          );
          return !unsettled.rows.length && !open.rows.length &&
              !operations.rows.length && !deadlines.rows.length
            ? true
            : undefined;
        }, "all retained deliveries and Actions to settle");
      }
      async function childEvidence() {
        return (await query<
          {
            type: string;
            body: {
              actionId: string;
              actionRunId: string;
              status: string;
              input: unknown;
              output?: unknown;
            };
          }
        >(
          `SELECT e.type,b.body FROM "${databaseSchema}".events e JOIN "${databaseSchema}".event_bodies b ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId' WHERE b.body->>'actionId'='retained.child' ORDER BY e.seq`,
        )).rows;
      }
      async function cleanup() {
        const failures: unknown[] = [];
        for (const close of [...closers].reverse()) {
          try {
            await close();
          } catch (error) {
            failures.push(error);
          }
        }
        try {
          await inspect.close();
        } finally {
          try {
            await admin.query(`DROP DATABASE "${databaseName}"`);
          } finally {
            await admin.close();
          }
        }
        if (failures.length) {
          throw new AggregateError(
            failures,
            "Retained graph fixture cleanup failed",
          );
        }
      }
      try {
        current = await start();
        assertEquals(await epoch(), 1);
        const firstInput = { id: "one", value: "first" };
        const firstOperation = await accepted(current, firstInput, "same");
        const firstDelivery = await eventually(async () => {
          const delivery = (await query<
            {
              status: string;
              attempts: number;
              last_error: unknown;
              id: string;
              event_id: string;
              consumer_id: string;
              settlement_scope_id: string;
              owner_epoch: string;
            }
          >(
            `SELECT * FROM "${databaseSchema}".event_deliveries WHERE consumer_id='processor:retained.capture'`,
          )).rows;
          return delivery.length === 1 && delivery[0].status === "retry_wait"
            ? delivery[0]
            : undefined;
        }, "persisted parent retry after completed child");
        assertEquals(firstDelivery.attempts, 1);
        assert(
          JSON.stringify(firstDelivery.last_error).includes(
            "retained parent interrupted after durable child result",
          ),
          JSON.stringify(firstDelivery.last_error),
        );
        assertEquals(counts, {
          roots: 1,
          processors: 1,
          preparations: 1,
          children: 1,
        });
        assertEquals(outputs, [{ id: "one", value: "original:first" }]);
        const initialChild = await childEvidence();
        assertEquals(initialChild.map((row) => row.body.status), [
          "invoked",
          "completed",
        ]);
        assertEquals(
          initialChild[0].body.actionRunId,
          `${firstDelivery.id}:action:retained.child:first-capture`,
        );
        assertEquals(claims.length, 1);
        assertEquals(claims[0].opening, 1);
        assertEquals(claims[0].deliveryId, firstDelivery.id);
        assertEquals(initialChild[0].body.input, {
          id: "one",
          value: "first",
          revision: "original",
        });
        assertEquals(initialChild[1].body.output, outputs[0]);
        assertEquals(
          initialChild[0].body.actionRunId,
          initialChild[1].body.actionRunId,
        );
        await current.close();
        current = undefined;
        // Change the actual source while every owner/worker connection is closed.
        // The retained child event/body is never fabricated or rewritten.
        await query(
          `UPDATE "${databaseSchema}".nodes SET data=jsonb_set(data,'{value}','"changed-after-shutdown"') WHERE namespace=$1 AND type='retained_record' AND id='one'`,
          [namespace],
        );
        assertEquals(
          (await query(
            `SELECT data->>'value' AS value FROM "${databaseSchema}".nodes WHERE id='one'`,
          )).rows,
          [{ value: "changed-after-shutdown" }],
        );
        const beforeRestart = await immutable();
        assertEquals({
          events: beforeRestart.events.length,
          bodies: beforeRestart.bodies.length,
          receipts: beforeRestart.receipts.length,
          nodes: beforeRestart.nodes.length,
          sequence: beforeRestart.sequence.length,
        }, { events: 8, bodies: 7, receipts: 0, nodes: 2, sequence: 8 });
        current = await start();
        assertEquals(await epoch(), 2);
        await settled();
        assertEquals(counts, {
          roots: 1,
          processors: 2,
          preparations: 1,
          children: 1,
        });
        assertEquals(outputs, [{ id: "one", value: "original:first" }, {
          id: "one",
          value: "original:first",
        }]);
        assertEquals(await childEvidence(), initialChild);
        const recovered = await immutable();
        const completion = recovered.events.at(-1)!;
        assertEquals(completion.type, "operation.catalog.changed");
        assertEquals(completion.payload, {
          kind: "operation",
          operationId: firstDelivery.settlement_scope_id,
          selectionKeys: [],
          state: { cancellation_requested_at: null, state: "completed" },
        });
        assertEquals(recovered.sequence.at(-1), {
          event_id: completion.id,
          sequence: completion.seq,
        });
        assertEquals(
          {
            ...recovered,
            events: recovered.events.slice(0, -1),
            sequence: recovered.sequence.slice(0, -1),
          },
          beforeRestart,
          "parent settlement adds exactly its catalog completion; child capture, Collection graph, lifecycle, and receipts stay unchanged",
        );
        const recoveredDelivery = (await query(
          `SELECT * FROM "${databaseSchema}".event_deliveries WHERE id=$1`,
          [firstDelivery.id],
        )).rows[0];
        assertEquals(recoveredDelivery.status, "succeeded");
        assertEquals(recoveredDelivery.attempts, 2);
        assertEquals(Number(recoveredDelivery.owner_epoch), 2);
        for (
          const key of [
            "id",
            "event_id",
            "consumer_id",
            "settlement_scope_id",
          ] as const
        ) assertEquals(recoveredDelivery[key], firstDelivery[key]);
        assertEquals(
          claims.map(({ opening, deliveryId }) => ({ opening, deliveryId })),
          [
            { opening: 1, deliveryId: firstDelivery.id },
            { opening: 2, deliveryId: firstDelivery.id },
          ],
        );
        assertEquals(new Set(claims.map(({ token }) => token)).size, 2);
        const replayBefore = await immutable();
        const replayDeliveries = await rows("event_deliveries", "id");
        const authorizationBefore = authorizations;
        assertEquals(
          await accepted(current, firstInput, "same"),
          firstOperation,
        );
        assert(authorizations > authorizationBefore);
        assertEquals(await immutable(), replayBefore);
        assertEquals(await rows("event_deliveries", "id"), replayDeliveries);
        allowed = false;
        assertEquals((await submit(current, firstInput, "same")).status, 403);
        assertEquals((await result(current, firstOperation)).status, 403);
        allowed = true;
        const conflict = await submit(current, {
          ...firstInput,
          value: "changed intent",
        }, "same");
        assertEquals(conflict.status, 409, await conflict.clone().text());
        assertEquals(
          (await conflict.json()).error.code,
          "idempotency_conflict",
        );
        assertEquals(await immutable(), replayBefore);
        assertEquals(await rows("event_deliveries", "id"), replayDeliveries);
        assertEquals(counts, {
          roots: 1,
          processors: 2,
          preparations: 1,
          children: 1,
        });
        const nextInput = { id: "two", value: "second" };
        const secondOperation = await accepted(current, nextInput, "next");
        await settled();
        assertEquals(counts, {
          roots: 2,
          processors: 3,
          preparations: 2,
          children: 2,
        });
        assertEquals(outputs[2], { id: "two", value: "replacement-2:second" });
        assertEquals((await rows("nodes", "namespace,id")).length, 4);
        assertEquals((await childEvidence()).map((row) => row.body.status), [
          "invoked",
          "completed",
          "invoked",
          "completed",
        ]);
        const secondSnapshot = await immutable();
        assertEquals({
          events: secondSnapshot.events.length,
          bodies: secondSnapshot.bodies.length,
          receipts: secondSnapshot.receipts.length,
          nodes: secondSnapshot.nodes.length,
          sequence: secondSnapshot.sequence.length,
        }, { events: 18, bodies: 14, receipts: 0, nodes: 4, sequence: 18 });
        assertEquals(claims.length, 3);
        assertEquals(claims[2].opening, 2);
        assert(claims[2].deliveryId !== firstDelivery.id);
        assertEquals(new Set(claims.map(({ token }) => token)).size, 3);
        const secondDeliveries = await rows("event_deliveries", "id");
        await current.close();
        current = undefined;
        current = await start();
        assertEquals(await epoch(), 3);
        await settled();
        assertEquals(
          await accepted(current, firstInput, "same"),
          firstOperation,
        );
        assertEquals(
          await accepted(current, nextInput, "next"),
          secondOperation,
        );
        assertEquals(await immutable(), secondSnapshot);
        assertEquals(await rows("event_deliveries", "id"), secondDeliveries);
        assertEquals(claims.length, 3);
        assertEquals(counts, {
          roots: 2,
          processors: 3,
          preparations: 2,
          children: 2,
        });
      } finally {
        await cleanup();
      }
    },
  });
}
