import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
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
import { CopilotzHttpError, createCopilotzClient } from "../../client/index.ts";
import { serverPlugin } from "../../plugins/server/plugin.ts";
import { defineServerFacade } from "../../server/index.ts";
import { listen } from "../adapters/deno/listen.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createEventStore } from "../events/store.ts";

const selected = Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL");
const namespace = "integrity-space";
const schema = "orphan_refusal";

type Row = Record<string, unknown>;
async function eventually<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Each case owns a fresh real PostgreSQL database, independent owner/worker
// connections at each opening, and one read-only observer during execution.
// Only the explicitly identified row is corrupted after all owners close.
async function fixture(
  boundary:
    | "captured-retry"
    | "open-effect"
    | "host-open-effect"
    | "quiet"
    | "settled",
) {
  assert(selected);
  assertEquals(Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"), selected);
  const url = new URL(selected);
  assert(["postgres:", "postgresql:"].includes(url.protocol));
  const admin = await createTestDatabase({ url: url.href, pgPoolMax: 1 });
  const databaseName = `orphan_refusal_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  url.pathname = `/${databaseName}`;
  const inspect = await createTestDatabase({ url: url.href, pgPoolMax: 1 });
  const query = <T extends Row = Row>(sql: string, values?: unknown[]) =>
    inspect.query<T>(sql, values);
  const rows = async (table: string, order: string) =>
    (await query(`SELECT * FROM "${schema}".${table} ORDER BY ${order}`)).rows;
  const reads: { sql: string; params: unknown[] }[] = [];
  const store = createEventStore({
    schema,
    session: {
      ...inspect,
      query(sql, params) {
        reads.push({ sql, params: [...(params ?? [])] });
        return inspect.query(sql, params);
      },
    },
  });
  const immutable = async () => ({
    events: await rows("events", "seq"),
    bodies: await rows("event_bodies", "namespace,event_body_id"),
    receipts: await rows("owner_receipts", "owner,domain,key"),
    nodes: await rows("nodes", "namespace,id"),
    sequence: await rows("owner_event_sequences", "sequence"),
    effects: await rows("action_effects", "namespace,action_run_id,step"),
  });
  const counts = {
    roots: 0,
    processors: 0,
    preparations: 0,
    children: 0,
    providers: 0,
  };
  const childEntered = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  const outputs: unknown[] = [];
  const claims: { opening: number; id: string; token: string }[] = [];
  const closers: (() => Promise<void>)[] = [];
  let opening = 0;
  const collection = (name: string) =>
    defineCollection({
      name,
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
  const collections = {
    records: collection("integrity_record"),
    results: collection("integrity_result"),
  };
  async function start() {
    const ordinal = ++opening;
    const database = await createTestDatabase({ url: url.href, pgPoolMax: 4 });
    const resources: (() => Promise<unknown>)[] = [() => database.close()];
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      const failures: unknown[] = [];
      for (const release of resources.reverse()) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, "Native integrity cleanup failed");
      }
    };
    closers.push(close);
    let nativeSocket: WebSocket | undefined;
    const alarms = new Set<() => void>();
    const child = defineAction({
      id: "integrity.child",
      async execute(
        input: { id: string; value: string; revision: number },
        context: ActionContext,
      ) {
        counts.children++;
        if (
          ["open-effect", "host-open-effect"].includes(boundary) &&
          ordinal === 1
        ) {
          assertEquals(await context.effect.begin("synthetic-send"), {
            status: "proceed",
          });
          // The synthetic provider counter is an observation, never a real send.
          counts.providers++;
          assert(nativeSocket);
          nativeSocket.close(4001, "test retains an unconfirmed child effect");
          if (!context.signal.aborted) {
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve(), {
                once: true,
              })
            );
          }
          throw context.signal.reason;
        }
        if (boundary === "quiet") {
          childEntered.resolve();
          await releaseChild.promise;
          context.signal.throwIfAborted();
        }
        const value = `${input.revision}:${input.value}`;
        await context.collections.results.create({
          id: `result:${input.id}`,
          value,
        }, { operationKey: "child-result" });
        return { id: input.id, value };
      },
    });
    const write = defineAction({
      id: "integrity.write",
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
    const waiter = defineAction({
      id: "integrity.waiter",
      execute(
        input: { id: string; value: string; revision: number },
        context: ActionContext,
      ) {
        return context.awaitOperation({
          start: { action: "child", input },
          handoff: {},
        });
      },
      resume(_handoff, outcome) {
        assertEquals(outcome.status, "completed");
        return "resumed";
      },
    });
    const actions = { write, child, waiter };
    const processors = {
      capture: defineProcessor<
        ProcessorContext<
          Record<string, never>,
          Record<string, never>,
          ActionCallers<typeof actions>
        >
      >({
        id: "integrity.capture",
        on: [{ eventType: "integrity_record.created" }],
        settlement: "detached",
        async handle(event, context) {
          counts.processors++;
          assert(event.durable);
          const claimed = (await query<
            {
              id: string;
              lease_owner: string;
              owner_epoch: string;
              status: string;
            }
          >(
            `SELECT id,lease_owner,owner_epoch,status FROM "${schema}".event_deliveries WHERE event_id=$1 AND consumer_id='processor:integrity.capture'`,
            [event.id],
          )).rows;
          assertEquals(claimed.length, 1);
          assertEquals(claimed[0].status, "leased");
          assertEquals(Number(claimed[0].owner_epoch), ordinal);
          assert(claimed[0].lease_owner.length > 0);
          claims.push({
            opening: ordinal,
            id: claimed[0].id,
            token: claimed[0].lease_owner,
          });
          const id = (event.data as { record: { id: string } }).record.id;
          const output = await context.actions.child.prepare(async () => {
            counts.preparations++;
            const record = await context.collections.records.get({ id });
            assertExists(record);
            assert(typeof record.value === "string");
            return { input: { id, value: record.value, revision: ordinal } };
          }, { operationKey: "first-capture" });
          outputs.push(structuredClone(output));
          if (boundary === "captured-retry" && ordinal === 1) {
            throw new Error(
              "test parent interrupted after durable child result",
            );
          }
        },
      }),
    };
    const workerId = `integrity-worker-${ordinal}`;
    const credential = crypto.randomUUID();
    const expiresAtMs = Date.now() + 60_000;
    const gateway = await createCopilotz({
      role: "gateway",
      namespace,
      databaseSchema: schema,
      database,
      actions,
      collections,
      processors,
      hostCommands: {
        probe: {
          namespace,
          databaseSchema: schema,
          principal: "integrity-observer",
          authorize() {},
          execute: (_input: Record<string, never>) => "ready",
        },
      },
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
              authenticate: (request) =>
                request.headers.has("x-refuse-authentication")
                  ? new Response(null, { status: 401 })
                  : {
                    actor: { id: "integrity-reader" },
                    namespace: request.headers.get("x-namespace") ?? namespace,
                  },
              authorize: (request) =>
                request.headers.has("x-refuse-authorization")
                  ? new Response(null, { status: 403 })
                  : request.headers.has("x-hide-operation")
                  ? { operations: { metadata: { hidden: true } } }
                  : {},
            }),
          },
        },
      })],
      transports: [{ type: "websocket", config: { path: "/workers" } }],
      target: { workerId },
      admit(context) {
        assertEquals(context.identity.workerId, workerId);
        assertEquals(context.credential.capability, credential);
        return {
          definition: {
            workerId,
            providerId: "integrity-fixture",
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
        maxAttempts: 2,
        retryBaseMs: 0,
        random: () => 0,
        alarmScheduler: {
          schedule(callback: () => void) {
            alarms.add(callback);
            return callback;
          },
          cancel(handle: unknown) {
            alarms.delete(handle as () => void);
          },
        },
      },
    });
    resources.push(() => gateway.close());
    // Factory readiness is measured separately from a connected worker and from
    // any explicit alarm wake. Its handler returns only a readiness marker;
    // it never manufactures lifecycle, capture, effect, or business rows.
    assertEquals(
      await gateway.hostCommands.invoke("probe", {}),
      "ready",
    );
    const factoryCounts = { ...counts };
    const listener = listen(gateway, { hostname: "127.0.0.1", port: 0 });
    resources.push(() => listener.shutdown());
    const workerUrl = new URL("/workers", listener.url);
    workerUrl.protocol = "ws:";
    const worker = await createCopilotz({
      role: "worker",
      namespace,
      databaseSchema: schema,
      id: workerId,
      actions,
      collections,
      processors,
      capacity: 4,
      transport: {
        type: "websocket",
        config: {
          url: workerUrl,
          allowInsecureLoopback: true,
          socket: ({ url, protocol }) => {
            nativeSocket = new WebSocket(url, protocol);
            return nativeSocket;
          },
        },
      },
      activate: () => ({
        workerId,
        attemptId: crypto.randomUUID(),
        epoch: ordinal,
      }),
      register: () => ({
        credential: { kind: "registration" as const, capability: credential },
        expiresAtMs,
      }),
      reconnectDelay: false,
    });
    resources.push(() => worker.close());
    await worker.ready;
    const wake = async () => {
      await eventually(
        () => alarms.size ? true : undefined,
        "actual scheduled owner alarm",
      );
      const callbacks = [...alarms];
      alarms.clear();
      for (const callback of callbacks) callback();
    };
    return { gateway, close, wake, ordinal, factoryCounts };
  }
  type Opened = Awaited<ReturnType<typeof start>>;
  const submit = (app: Opened, id: string) =>
    app.gateway.fetch(
      new Request("http://integrity.test/api/actions/integrity/write", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": id },
        body: JSON.stringify({ id, value: `value-${id}` }),
      }),
    );
  const accepted = async (app: Opened, id: string) => {
    const response = await submit(app, id);
    assertEquals(response.status, 202, await response.clone().text());
    const operationId = (await response.json()).data.operationId as string;
    const completed = await eventually(async () => {
      const response = await app.gateway.fetch(
        new Request(
          `http://integrity.test/api/operations/${operationId}/result`,
        ),
      );
      return response.status === 202 ? undefined : response;
    }, `root result ${id}`);
    assertEquals(completed.status, 200, await completed.clone().text());
    assertEquals((await completed.json()).data, `accepted:${id}`);
    return operationId;
  };
  const delivery = async (status: string, attempts: number) =>
    await eventually(async () => {
      const all = (await query(
        `SELECT * FROM "${schema}".event_deliveries WHERE consumer_id='processor:integrity.capture' ORDER BY created_at`,
      )).rows;
      return all.find((row) =>
        row.status === status && row.attempts === attempts
      );
    }, `parent delivery ${status}/${attempts}`);
  const childEvidence = async () =>
    (await query<
      {
        id: string;
        event_body_id: string;
        digest: string;
        body: {
          actionRunId: string;
          actionId: string;
          status: string;
          input: unknown;
          output?: unknown;
        };
      }
    >(
      `SELECT e.id,b.event_body_id,b.digest,b.body FROM "${schema}".events e JOIN "${schema}".event_bodies b ON b.namespace=e.namespace AND b.event_body_id=e.payload->'dataRef'->>'eventBodyId' WHERE b.body->>'actionId'='integrity.child' ORDER BY e.seq`,
    )).rows;
  const settled = async () =>
    await eventually(async () => {
      const pending = (await query(
        `SELECT 1 FROM "${schema}".event_deliveries WHERE status <> 'succeeded' UNION ALL SELECT 1 FROM "${schema}".open_actions UNION ALL SELECT 1 FROM "${schema}".copilotz_operations WHERE state <> 'completed'`,
      )).rows;
      return pending.length ? undefined : true;
    }, "all genuine graph work settled");
  const cleanup = async () => {
    releaseChild.resolve();
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
      throw new AggregateError(failures, "Native integrity cleanup failed");
    }
  };
  return {
    start,
    query,
    rows,
    reads,
    outstanding: store.scopeOutstanding,
    childEntered: childEntered.promise,
    releaseChild: () => releaseChild.resolve(),
    immutable,
    counts,
    outputs,
    claims,
    accepted,
    submit,
    delivery,
    childEvidence,
    settled,
    cleanup,
  };
}

Deno.test({
  name:
    "PostgreSQL retained invoked digest mismatch leaves valid terminal reuse and original evidence unchanged",
  ignore: !selected,
  async fn() {
    const f = await fixture("captured-retry");
    try {
      const first = await f.start();
      await f.accepted(first, "original");
      const parent = await f.delivery("retry_wait", 1);
      const children = await f.childEvidence();
      assertEquals(children.map((row) => row.body.status), [
        "invoked",
        "completed",
      ]);
      assertEquals(
        children[0].body.actionRunId,
        `${parent.id}:action:integrity.child:first-capture`,
      );
      assertEquals(f.counts, {
        roots: 1,
        processors: 1,
        preparations: 1,
        children: 1,
        providers: 0,
      });
      assertEquals(children[0].body.input, {
        id: "original",
        value: "value-original",
        revision: 1,
      });
      assertEquals(children[1].body.output, {
        id: "original",
        value: "1:value-original",
      });
      await first.close();
      const before = await f.immutable();
      const corruptDigest = `sha256:${"0".repeat(64)}`;
      assert(children[0].digest !== corruptDigest);
      const changed = await f.query(
        `UPDATE "${schema}".event_bodies SET digest=$1 WHERE namespace=$2 AND event_body_id=$3 AND digest=$4 RETURNING *`,
        [
          corruptDigest,
          namespace,
          children[0].event_body_id,
          children[0].digest,
        ],
      );
      assertEquals(changed.rows.length, 1);
      const corrupted = await f.immutable();
      assertEquals({ ...corrupted, bodies: before.bodies }, before);
      assertEquals(
        corrupted.bodies,
        before.bodies.map((row) =>
          row.event_body_id === children[0].event_body_id
            ? { ...row, digest: corruptDigest }
            : row
        ),
      );
      const reopened = await f.start();
      const atReady = reopened.factoryCounts;
      await reopened.wake();
      const recovered = await f.delivery("succeeded", 2);
      await f.settled();
      assertEquals(recovered.id, parent.id);
      assertEquals(Number(recovered.owner_epoch), 2);
      assertEquals(f.claims.map(({ opening, id }) => ({ opening, id })), [
        { opening: 1, id: parent.id },
        { opening: 2, id: parent.id },
      ]);
      assertEquals(new Set(f.claims.map(({ token }) => token)).size, 2);
      assertEquals(f.counts, {
        roots: 1,
        processors: 2,
        preparations: 1,
        children: 1,
        providers: 0,
      });
      assertEquals(f.outputs, [
        { id: "original", value: "1:value-original" },
        { id: "original", value: "1:value-original" },
      ]);
      assertEquals(
        await f.childEvidence(),
        children.map((row, index) =>
          index === 0 ? { ...row, digest: corruptDigest } : row
        ),
      );
      const after = await f.immutable();
      const completion = after.events.at(-1)!;
      assertEquals(completion.type, "operation.catalog.changed");
      assertEquals(completion.payload, {
        kind: "operation",
        operationId: parent.settlement_scope_id,
        selectionKeys: [],
        state: { cancellation_requested_at: null, state: "completed" },
      });
      assertEquals(after.sequence.at(-1), {
        owner: "schema",
        event_id: completion.id,
        sequence: completion.seq,
      });
      assertEquals({
        ...after,
        events: after.events.slice(0, -1),
        sequence: after.sequence.slice(0, -1),
      }, corrupted);
      await f.accepted(reopened, "unrelated");
      await f.delivery("succeeded", 1);
      assertEquals(f.counts, {
        roots: 2,
        processors: 3,
        preparations: 2,
        children: 2,
        providers: 0,
      });
      assertEquals(f.outputs.at(-1), {
        id: "unrelated",
        value: "2:value-unrelated",
      });
      console.log("native digest observation", {
        factoryReady: true,
        atReady,
        parentStatus: recovered.status,
        retainedChildEvents: children.length,
        unrelated: "completed",
      });
    } finally {
      await f.cleanup();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL orphaned actual open child Action refuses result reads without settling its effect or receipt",
  ignore: !selected,
  async fn() {
    const f = await fixture("open-effect");
    try {
      const first = await f.start();
      const originalRoot = await f.accepted(first, "original");
      const parent = await f.delivery("retry_wait", 1);
      const children = await f.childEvidence();
      assertEquals(children.map((row) => row.body.status), ["invoked"]);
      const open = await f.rows("open_actions", "namespace,action_run_id");
      assertEquals(open.length, 1);
      assertEquals(open[0].invoked_event_id, children[0].id);
      assertEquals(open[0].owner_delivery_id, parent.id);
      assertEquals(
        children[0].body.actionRunId,
        `${parent.id}:action:integrity.child:first-capture`,
      );
      assertEquals(f.counts, {
        roots: 1,
        processors: 1,
        preparations: 1,
        children: 1,
        providers: 1,
      });
      assertEquals(
        await f.outstanding(namespace, String(parent.settlement_scope_id)),
        { unsettled: 1, deadLetters: 0, cancelled: 0 },
      );
      await first.close();
      const before = await f.immutable();
      assertEquals(children[0].body.input, {
        id: "original",
        value: "value-original",
        revision: 1,
      });
      assertEquals(before.effects, [{
        namespace,
        action_run_id: children[0].body.actionRunId,
        step: "synthetic-send",
        ancestors: [],
        status: "begun",
        outcome: null,
        evidence: null,
      }]);
      const missing = `missing:${parent.id}`;
      assertEquals(
        (await f.query(
          `SELECT id FROM "${schema}".event_deliveries WHERE id=$1`,
          [missing],
        )).rows,
        [],
      );
      assertEquals(
        (await f.query(
          `UPDATE "${schema}".open_actions SET owner_delivery_id=$1 WHERE namespace=$2 AND action_run_id=$3 AND owner_delivery_id=$4 RETURNING *`,
          [missing, namespace, open[0].action_run_id, parent.id],
        )).rows,
        [{ ...open[0], owner_delivery_id: missing }],
      );
      const corruptedOpen = await f.rows(
        "open_actions",
        "namespace,action_run_id",
      );
      // Native foreign keys disallow missing invoked-event history. Do not drop
      // constraints or delete other rows to manufacture that unsupported variant.
      await assertRejects(
        () =>
          f.query(`DELETE FROM "${schema}".events WHERE id=$1`, [
            children[0].id,
          ]),
        Error,
        "foreign key",
      );
      assertEquals(await f.immutable(), before);
      const reopened = await f.start();
      const atReady = reopened.factoryCounts;
      const firstRead = await reopened.gateway.fetch(
        new Request(
          `http://integrity.test/api/operations/${
            encodeURIComponent(String(parent.settlement_scope_id))
          }/result`,
        ),
      );
      assertEquals(firstRead.status, 409);
      assertEquals(await firstRead.json(), {
        error: {
          code: "operation_result_unavailable",
          message: "Operation result is unavailable.",
        },
      });
      assertEquals(await f.immutable(), before);
      await reopened.wake();
      const refused = await f.delivery("dead_letter", 2);
      assertEquals(refused.id, parent.id);
      assertEquals(Number(refused.owner_epoch), 2);
      assertEquals(f.claims.map(({ opening, id }) => ({ opening, id })), [
        { opening: 1, id: parent.id },
        { opening: 2, id: parent.id },
      ]);
      assertEquals(new Set(f.claims.map(({ token }) => token)).size, 2);
      assertEquals(
        await f.rows("open_actions", "namespace,action_run_id"),
        corruptedOpen,
      );
      assertEquals(await f.childEvidence(), children);
      assertEquals(f.counts, {
        roots: 1,
        processors: 2,
        preparations: 1,
        children: 1,
        providers: 1,
      });
      assertEquals(f.outputs, []);
      assertEquals(await f.immutable(), before);
      assertEquals(
        (refused.last_error as { name: string }).name,
        "ActionOwnershipLost",
      );
      const scope = {
        namespace,
        operationId: String(parent.settlement_scope_id),
      };
      const status = await reopened.gateway.operationStatus(scope);
      assertExists(status);
      assertEquals(status.state, "running");
      assertEquals(status.completedAt, undefined);
      f.reads.length = 0;
      const unavailableRead = await assertRejects(
        () => f.outstanding(namespace, scope.operationId),
        Error,
        "Operation result is unavailable.",
      );
      assertEquals(
        (unavailableRead as Error & { code: string }).code,
        "operation_result_unavailable",
      );
      assertEquals(f.reads.length, 1);
      assertEquals(f.reads[0].params, [namespace, scope.operationId]);
      assertEquals(/\b(UPDATE|INSERT|DELETE)\b/.test(f.reads[0].sql), false);
      assertEquals(await f.outstanding("other-space", scope.operationId), {
        unsettled: 0,
        deadLetters: 0,
        cancelled: 0,
      });
      assertEquals(await f.outstanding(namespace, "unrelated-operation"), {
        unsettled: 0,
        deadLetters: 0,
        cancelled: 0,
      });
      const resultUrl = `http://integrity.test/api/operations/${
        encodeURIComponent(scope.operationId)
      }/result`;
      const result = await reopened.gateway.fetch(new Request(resultUrl));
      assertEquals(result.status, 409);
      assertEquals(await result.json(), {
        error: {
          code: "operation_result_unavailable",
          message: "Operation result is unavailable.",
        },
      });
      for (
        const [headers, expected] of [
          [{ "x-refuse-authentication": "true" }, 401],
          [{ "x-refuse-authorization": "true" }, 403],
          [{ "x-hide-operation": "true" }, 404],
          [{ "x-namespace": "other-space" }, 404],
        ] as const
      ) {
        const denied = await reopened.gateway.fetch(
          new Request(resultUrl, { headers }),
        );
        assertEquals(denied.status, expected);
        assertEquals(
          (await denied.text()).includes("operation_result_unavailable"),
          false,
        );
      }
      const absent = await reopened.gateway.fetch(
        new Request(
          "http://integrity.test/api/operations/missing-operation/result",
        ),
      );
      assertEquals(absent.status, 404);
      assertEquals((await absent.json()).error.code, "operation_not_found");
      // Public observation fails without emitting a false operation terminal.
      const attachment = await reopened.gateway.attach(scope);
      const observed: string[] = [];
      const reading = (async () => {
        for await (const output of attachment.outputs) {
          observed.push(output.type);
        }
      })();
      await Promise.all([attachment.done, reading].map(async (promise) => {
        const error = await assertRejects(
          () => bounded(promise, "orphan attachment refusal"),
          Error,
          "Operation result is unavailable.",
        );
        assertEquals(
          (error as Error & { code: string }).code,
          "operation_result_unavailable",
        );
      }));
      await attachment.drained;
      await attachment.detach();
      assertEquals(
        observed.some((type) =>
          ["operation.completed", "operation.failed", "operation.cancelled"]
            .includes(type)
        ),
        false,
      );
      const requests: { method: string; url: string; key: string | null }[] =
        [];
      const client = createCopilotzClient({
        baseUrl: "http://integrity.test/api",
        fetch: ((url, init) => {
          const request = new Request(url, init);
          requests.push({
            method: request.method,
            url: request.url,
            key: request.headers.get("idempotency-key"),
          });
          return reopened.gateway.fetch(request);
        }) as typeof fetch,
      });
      const unavailable = await assertRejects(
        () => client.operations.result(scope.operationId),
        CopilotzHttpError,
      );
      assertEquals(unavailable.code, "operation_result_unavailable");
      assertEquals(unavailable.status, 409);
      assertEquals(requests, [{ method: "GET", url: resultUrl, key: null }]);
      // A read refusal does not rewrite the receipt or authorize new admission.
      assertEquals(await reopened.gateway.operationStatus(scope), status);
      assertEquals(
        await client.operations.result(originalRoot),
        "accepted:original",
      );
      const originalReceipt = await f.submit(reopened, "original");
      assertEquals(originalReceipt.status, 202);
      assertEquals(
        (await originalReceipt.json()).data.operationId,
        originalRoot,
      );
      assertEquals(await f.immutable(), before);
      const deliveriesBeforeMaintenance = await f.rows(
        "event_deliveries",
        "id",
      );
      const maintenance = await reopened.gateway.maintenance({
        namespace,
        retentionMs: null,
        operationRetentionMs: null,
        limit: 100,
      });
      assertEquals(maintenance.recovered, 0);
      assertEquals(maintenance.operations.reconciled, 0);
      assertEquals(await reopened.gateway.operationStatus(scope), status);
      const afterMaintenanceResult = await reopened.gateway.fetch(
        new Request(resultUrl),
      );
      assertEquals(afterMaintenanceResult.status, 409);
      assertEquals(await afterMaintenanceResult.json(), {
        error: {
          code: "operation_result_unavailable",
          message: "Operation result is unavailable.",
        },
      });
      assertEquals(await f.immutable(), before);
      assertEquals(
        await f.rows("event_deliveries", "id"),
        deliveriesBeforeMaintenance,
      );
      assertEquals(
        await f.rows("open_actions", "namespace,action_run_id"),
        corruptedOpen,
      );
      console.log("native orphan observation", {
        factoryReady: true,
        atReady,
        parentStatus: refused.status,
        error: (refused.last_error as { name: string }).name,
        publicOperationState: status.state,
        publicResultStatus: result.status,
        maintenanceRecovered: maintenance.recovered,
        maintenanceReconciled: maintenance.operations.reconciled,
        retainedOpenActions: corruptedOpen.length,
      });
      await f.accepted(reopened, "unrelated");
      await f.delivery("succeeded", 1);
      assertEquals(f.counts, {
        roots: 2,
        processors: 3,
        preparations: 2,
        children: 2,
        providers: 1,
      });
      assertEquals(f.outputs, [{
        id: "unrelated",
        value: "2:value-unrelated",
      }]);
      assertEquals(
        await f.rows("open_actions", "namespace,action_run_id"),
        corruptedOpen,
      );
      assertEquals(await reopened.gateway.operationStatus(scope), status);
      assertEquals(
        await f.rows("action_effects", "namespace,action_run_id,step"),
        before.effects,
      );
    } finally {
      await f.cleanup();
    }
  },
});

for (const source of ["unregistered-source", ""] as const) {
  Deno.test({
    name: `PostgreSQL retained ${
      source ? "unknown" : "empty"
    } deadline source becomes a truthful owner refusal at actual wake`,
    ignore: !selected,
    async fn() {
      const f = await fixture("settled");
      try {
        const first = await f.start();
        await f.accepted(first, "original");
        await f.settled();
        await first.close();
        const retained = await f.immutable();
        const inserted = (await f.query(
          `INSERT INTO "${schema}".owner_deadlines(owner,source,key,namespace,due_at,payload) VALUES('schema',$1,$2,$3,'2000-01-01T00:00:00Z',$4::jsonb) RETURNING *`,
          [
            source,
            `native:${source}`,
            namespace,
            JSON.stringify({ retainedEventId: retained.events[0].id }),
          ],
        )).rows;
        assertEquals(inserted.length, 1);
        const reopened = await f.start();
        assertEquals(await f.immutable(), retained);
        assertEquals(f.counts, {
          roots: 1,
          processors: 1,
          preparations: 1,
          children: 1,
          providers: 0,
        });
        // Unrelated current work is accepted before the intentionally held wake.
        await f.accepted(reopened, "before-wake");
        await f.settled();
        const beforeWake = await f.immutable();
        await reopened.wake();
        const failure = await eventually(async () => {
          try {
            await reopened.gateway.hostCommands.invoke("probe", {});
            return undefined;
          } catch (error) {
            return error;
          }
        }, "public owner command refuses after unknown source wake");
        assert(
          String(failure).includes(
            `No owner alarm handler registered for '${source}'`,
          ),
          String(failure),
        );
        const refused = await f.submit(reopened, "after-wake");
        assertEquals(refused.status, 500, await refused.clone().text());
        assertEquals(await f.immutable(), beforeWake);
        assertEquals(
          (await f.query(
            `SELECT * FROM "${schema}".owner_deadlines WHERE owner='schema' AND source=$1 AND key=$2`,
            [source, `native:${source}`],
          )).rows,
          inserted,
        );
        assertEquals(f.counts, {
          roots: 2,
          processors: 2,
          preparations: 2,
          children: 2,
          providers: 0,
        });
        console.log("native deadline observation", {
          source,
          factoryReady: true,
          beforeWake: "unrelated work completed",
          afterWake: String(failure),
          refusedStatus: refused.status,
          deadlineRetained: true,
        });
      } finally {
        await f.cleanup();
      }
    },
  });
}

Deno.test({
  name:
    "PostgreSQL same-key host result settlement waiter refuses an orphan without repeating its begun effect",
  ignore: !selected,
  async fn() {
    const f = await fixture("host-open-effect");
    try {
      const input = { id: "host-original", value: "retained", revision: 1 };
      const first = await f.start();
      const originalCall = first.gateway.actions.child(input, {
        idempotencyKey: "host-original",
      });
      // Closing the original owner interrupts only its local caller.
      void originalCall.catch(() => undefined);
      const open = await eventually(async () => {
        const rows = await f.rows("open_actions", "action_run_id");
        return rows.find((row) =>
          row.action_id === "integrity.child" && f.counts.providers === 1
        );
      }, "actual host child effect begun");
      await eventually(async () => {
        const rows = (await f.query(
          `SELECT * FROM "${schema}".event_deliveries WHERE id=$1`,
          [open.owner_delivery_id],
        )).rows;
        return rows[0]?.status === "retry_wait" ? true : undefined;
      }, "host parent retry retained");
      await first.close();
      await assertRejects(() => originalCall);
      const before = await f.immutable();
      const originalOpen = await f.rows(
        "open_actions",
        "namespace,action_run_id",
      );
      assertEquals(before.effects.length, 1);
      assertEquals(before.effects[0].status, "begun");
      assertEquals(before.effects[0].outcome, null);
      assertEquals(before.effects[0].evidence, null);
      const missing = `missing:${open.owner_delivery_id}`;
      assertEquals(
        (await f.query(
          `SELECT id FROM "${schema}".event_deliveries WHERE id=$1`,
          [missing],
        )).rows,
        [],
      );
      assertEquals(
        (await f.query(
          `UPDATE "${schema}".open_actions SET owner_delivery_id=$1 WHERE namespace=$2 AND action_run_id=$3 AND owner_delivery_id=$4 RETURNING *`,
          [missing, namespace, open.action_run_id, open.owner_delivery_id],
        )).rows,
        [{ ...open, owner_delivery_id: missing }],
      );
      const corruptedOpen = originalOpen.map((row) =>
        row.action_run_id === open.action_run_id
          ? { ...row, owner_delivery_id: missing }
          : row
      );
      const reopened = await f.start();
      const error = await assertRejects(
        () =>
          bounded(
            reopened.gateway.actions.child(input, {
              idempotencyKey: "host-original",
            }),
            "same-key host refusal",
          ),
        Error,
        "Operation result is unavailable.",
      );
      assertEquals(
        (error as Error & { code: string }).code,
        "operation_result_unavailable",
      );
      assertEquals((error as Error & { status: number }).status, 409);
      assertEquals(f.counts.providers, 1);
      assertEquals(f.counts.children, 1);
      assertEquals(await f.immutable(), before);
      assertEquals(
        await f.rows("open_actions", "namespace,action_run_id"),
        corruptedOpen,
      );
      const status = await reopened.gateway.operationStatus({
        operationId: String(open.scope_id),
      });
      assertExists(status);
      assertEquals(status.state, "running");
      assertEquals(status.completedAt, undefined);
    } finally {
      await f.cleanup();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL healthy quiet child and awaiting Action retain pending reads and complete normally",
  ignore: !selected,
  async fn() {
    const f = await fixture("quiet");
    try {
      const owner = await f.start();
      const result = owner.gateway.actions.waiter({
        id: "quiet",
        value: "original",
        revision: 1,
      }, { idempotencyKey: "quiet" });
      void result.catch(() => undefined);
      await bounded(f.childEntered, "quiet child entered");
      const awaiting = await eventually(async () => {
        const rows = await f.rows("open_actions", "action_run_id");
        return rows.find((row) =>
          row.action_id === "integrity.waiter" && row.state === "awaiting"
        );
      }, "actual awaiting Action");
      assertEquals(awaiting.owner_delivery_id, null);
      const invoked = (await f.rows("open_actions", "action_run_id")).find((
        row,
      ) => row.action_id === "integrity.child")!;
      assertExists(invoked);
      assertEquals(invoked.state, "invoked");
      const ownerDelivery = (await f.query(
        `SELECT * FROM "${schema}".event_deliveries WHERE id=$1`,
        [invoked.owner_delivery_id],
      )).rows[0];
      assertExists(ownerDelivery);
      assertEquals(ownerDelivery.status, "leased");
      const before = await f.immutable();
      const openBefore = await f.rows("open_actions", "action_run_id");
      for (const action of [awaiting, invoked]) {
        const id = String(action.scope_id);
        await f.outstanding(namespace, id);
        const response = await owner.gateway.fetch(
          new Request(
            `http://integrity.test/api/operations/${
              encodeURIComponent(id)
            }/result`,
          ),
        );
        assertEquals(response.status, 202);
        assertEquals((await response.json()).data.status, "running");
      }
      assertEquals(await f.immutable(), before);
      assertEquals(await f.rows("open_actions", "action_run_id"), openBefore);
      f.releaseChild();
      assertEquals(
        await bounded(result, "genuine continuation completion"),
        "resumed",
      );
      await f.settled();
      assertEquals(f.counts.children, 1);
      assertEquals(f.counts.providers, 0);
    } finally {
      await f.cleanup();
    }
  },
});
