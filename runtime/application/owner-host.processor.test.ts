import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import { createOwnerConnection } from "../owner/connection.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import {
  defineProcessor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import { createOwnerActionCallers } from "./owner-actions.ts";
import { createOwnerHost } from "./owner-host.ts";
import { createOwnerConnectedWorker } from "./owner-worker.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => resolve = yes);
  return { promise, resolve };
}
async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 15_000;
  while (!await check()) {
    if (Date.now() >= until) {
      throw new Error("Processor host fixture timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
const cases: readonly {
  placement: "worker" | "owner-local";
  mode: "in-process" | "websocket";
  nestedChildren?: boolean;
  localChild?: boolean;
  fault?:
    | "child-ordinal"
    | "predecessor-grant"
    | "predecessor-event"
    | "retry-identity"
    | "retry-cancellation"
    | "held-completion"
    | "unknown-completion"
    | "held-start"
    | "mixed-capacity"
    | "close-held-factory"
    | "submillisecond";
}[] = [
  ...(["worker", "owner-local"] as const).flatMap((placement) =>
    (["in-process", "websocket"] as const).map((mode) => ({ placement, mode }))
  ),
  ...(["in-process", "websocket"] as const).map((mode) => ({
    placement: "owner-local" as const,
    mode,
    nestedChildren: true,
  })),
  ...(["in-process", "websocket"] as const).map((mode) => ({
    placement: "owner-local" as const,
    mode,
    nestedChildren: true,
    localChild: true,
  })),
  {
    placement: "owner-local",
    mode: "in-process",
    nestedChildren: true,
    fault: "child-ordinal",
  },
  ...([
    "predecessor-grant",
    "predecessor-event",
    "retry-identity",
    "retry-cancellation",
    "held-completion",
    "unknown-completion",
    "held-start",
    "mixed-capacity",
    "close-held-factory",
    "submillisecond",
  ] as const)
    .map((fault) => ({
      placement: "owner-local" as const,
      mode: "in-process" as const,
      fault,
    })),
];
for (const { placement, mode, fault, nestedChildren, localChild } of cases) {
  test(
    `owner whole-plugin ${mode} ${placement}${
      fault
        ? ` ${fault}`
        : localChild
        ? " nested-local-child"
        : nestedChildren
        ? " nested-child"
        : ""
    }: Collection → Processor, detached scope and due retry`,
    {
      skip: !sourceRoot,
      timeout: 45_000,
    },
    async () => {
      const { entrypoints } = await resolveOxianSource(sourceRoot!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const db = await createTestDatabase({
        pgliteMemoryProfile: "low-memory",
      });
      const heldReply = deferred(), releaseReply = deferred();
      const releaseFactory = deferred();
      let factoryHeld = false;
      let replyInjected = false;
      const session: SqlSession =
        fault === "held-completion" || fault === "unknown-completion" ||
          fault === "held-start" || fault === "submillisecond"
          ? {
            query: db.query.bind(db),
            async transaction(run) {
              let selected = false;
              const result = await db.transaction(async (tx) =>
                await run({
                  async query<TRow extends Record<string, unknown>>(
                    sql: string,
                    values?: unknown[],
                  ) {
                    // Fix only this probe's retry backoff; retain SQL's
                    // fractional command timestamp rather than injecting a
                    // different persisted timestamp after the receipt.
                    const args = fault === "submillisecond" &&
                        sql.includes("SET status = CASE WHEN $5") && values
                      ? [...values.slice(0, 2), 1000, ...values.slice(3)]
                      : values;
                    const result = await tx.query<TRow>(sql, args);
                    if (
                      fault !== "submillisecond" && !replyInjected &&
                      sql.startsWith(
                        'INSERT INTO "public"."owner_receipts"(',
                      ) &&
                      ((fault === "held-start" &&
                        values?.[5] === "owner.local-processor-start") ||
                        (values?.[5] === "processor.local-complete" &&
                          JSON.parse(String(values[7])).status ===
                            "retry_wait"))
                    ) {
                      selected = true;
                      replyInjected = true;
                    }
                    return result;
                  },
                })
              );
              if (selected) {
                heldReply.resolve();
                if (fault === "unknown-completion") {
                  throw Object.assign(
                    new Error(
                      "lost committed Processor completion acknowledgement",
                    ),
                    { code: "persistence_indeterminate" },
                  );
                }
                await releaseReply.promise;
              }
              return result;
            },
          }
          : db;
      const release = deferred();
      const releaseRevoked = deferred();
      let revokedStarted = false;
      let eventAllowed = true;
      let replayDenied = false;
      let childDenied = false;
      let policyDenials = 0;
      let firstStarted = false;
      let time = Date.now();
      let microsecond = 1;
      let retryCalls = 0;
      let localActionFactories = 0,
        localProcessorFactories = 0,
        workerProcessorFactories = 0;
      let faultInjected = false;
      async function mutatePredecessor(tx: SqlExecutor, deliveryId: string) {
        const rows = (await tx.query(
          "SELECT assignment_key FROM owner_assignments WHERE delivery_id=$1 AND retired=TRUE",
          [deliveryId],
        )).rows;
        if (rows.length && !faultInjected) {
          faultInjected = true;
          await tx.query(
            "UPDATE owner_assignments SET retired=FALSE WHERE assignment_key=$1",
            [rows[0].assignment_key],
          );
        }
      }
      const errors: unknown[] = [];
      const observed: string[] = [];
      const childRuns = new Map<string, number>();
      const collection = (name: string) =>
        defineCollection({
          name,
          schema: {
            type: "object",
            properties: { id: { type: "string" }, title: { type: "string" } },
          } as const,
        });
      const registry = createPluginRegistry({
        plugins: [definePlugin({
          id: "fixture.whole",
          version: "1",
          collections: {
            notes: collection("note"),
            replies: collection("reply"),
            audits: collection("audit"),
          },
          resources: { fixture: { label: "whole-plugin" } },
          adapters: {
            recorder: { record: (value: string) => observed.push(value) },
          },
          actions: {
            root: defineAction({
              id: "fixture.root",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              async execute(value: string, ctx: ActionContext) {
                if (value === "nested") {
                  const invoke = ctx.actions.child as (
                    input: string,
                    options: { operationKey: string },
                  ) => Promise<unknown>;
                  return `root:${await invoke(value, {
                    operationKey: "nested",
                  })}`;
                }
                await ctx.transaction(
                  ({ collections }) =>
                    collections.notes.create({ id: value, title: value }),
                  { operationKey: "write" },
                );
                return `root:${value}`;
              },
            }),
            child: defineAction({
              id: "fixture.child",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              async execute(value: string, ctx: ActionContext) {
                childRuns.set(value, (childRuns.get(value) ?? 0) + 1);
                await ctx.transaction(
                  ({ collections }) =>
                    collections.replies.create({
                      id: `reply:${value}`,
                      title: value,
                    }),
                  { operationKey: "write" },
                );
                return `child:${value}`;
              },
            }),
          },
          processors: {
            follow: defineProcessor({
              id: "fixture.follow",
              on: [{ eventType: "note.created" }],
              async handle(event, ctx: ProcessorContext) {
                const value =
                  (event.data as { record: { title: string } }).record.title;
                assert.equal(
                  (ctx.resources.fixture as { label: string }).label,
                  "whole-plugin",
                );
                if (value === "first") {
                  firstStarted = true;
                  await release.promise;
                }
                if (
                  value === "retry" && ++retryCalls === 1 && !nestedChildren
                ) {
                  throw new Error("retry before any effect");
                }
                if (value === "revoked") {
                  const write = () =>
                    ctx.transaction(
                      ({ collections }) =>
                        collections.replies.create({
                          id: "policy:revoked",
                          title: value,
                        }),
                      { operationKey: "policy-write" },
                    );
                  await write();
                  revokedStarted = true;
                  await releaseRevoked.promise;
                  try {
                    await write();
                  } catch {
                    replayDenied = true;
                  }
                  try {
                    await (ctx.actions.child as (
                      input: string,
                      options: { operationKey: string },
                    ) => Promise<unknown>)(value, { operationKey: "child" });
                  } catch {
                    childDenied = true;
                  }
                  if (!replayDenied || !childDenied) {
                    throw new Error(
                      "revoked Processor authority reached a replay or child",
                    );
                  }
                  throw new Error("current event policy revoked");
                }
                if (placement === "owner-local" && !nestedChildren) {
                  await ctx.transaction(
                    ({ collections }) =>
                      collections.replies.create({
                        id: `reply:${value}`,
                        title: value,
                      }),
                    { operationKey: "write" },
                  );
                } else {
                  const callChild = ctx.actions.child as (
                    input: string,
                    options: { operationKey: string },
                  ) => Promise<unknown>;
                  const result = await callChild(value, {
                    operationKey: "child",
                  });
                  assert.equal(result, `child:${value}`);
                  if (nestedChildren && value === "retry" && retryCalls === 1) {
                    throw new Error("retry after known child result");
                  }
                }
                (ctx.adapters.recorder as { record(value: string): void })
                  .record(value);
              },
            }),
            detached: defineProcessor({
              id: "fixture.detached",
              on: [{ eventType: "note.created" }],
              settlement: "detached",
              async handle(event, ctx: ProcessorContext) {
                const value =
                  (event.data as { record: { title: string } }).record.title;
                await ctx.transaction(
                  ({ collections }) =>
                    collections.audits.create({
                      id: `audit:${value}`,
                      title: value,
                    }),
                  { operationKey: "write" },
                );
              },
            }),
          },
        })],
      });
      const local = {
        type: "in-process" as const,
        config: { topic: crypto.randomUUID() },
      };
      const policy = {
        ingress: (
          _tx: unknown,
          context: { fence: { identity: { workerId: string } } },
        ) =>
          context.fence.identity.workerId === "ingress"
            ? {
              namespace: "space",
              principalKey: "api:fixture",
              principal: { actorId: "api:fixture" },
              route: { kind: "wrapper" as const, id: "root-only" },
              allowedActions: ["root"],
              actionMetadata: {},
              operationMetadata: { tenant: "space" },
              metadataConstraints: encodeOwnerMetadataConstraints({
                actorId: "api:fixture",
                tenant: "space",
              }),
              group: { key: "fixture", actorId: "api:fixture" },
            }
            : undefined,
        worker: () => ({ ctx: true, settlement: true }),
        input() {},
        collections: () => ({}),
        processorEvent(
          _tx: unknown,
          _assignment: unknown,
          _event: unknown,
          data: unknown,
        ) {
          if (
            !eventAllowed &&
            (data as { record: { title: string } }).record.title === "revoked"
          ) {
            policyDenials++;
            throw new Error("fixture event policy revoked");
          }
        },
        async child(
          tx: unknown,
          parent: {
            namespace: string;
            delivery: { id: string; consumerId: string };
          },
          actionId: string,
        ) {
          assert.equal(parent.namespace, "space");
          assert.equal(actionId, "fixture.child");
          if (
            fault === "child-ordinal" && !faultInjected &&
            parent.delivery.consumerId === "processor:fixture.follow"
          ) {
            await (tx as SqlExecutor).query(
              "UPDATE event_deliveries SET attempts=attempts+1 WHERE id=$1",
              [parent.delivery.id],
            );
            faultInjected = true;
          }
        },
        effectOutcome: () => false,
        effectNotStarted: () => false,
      };
      const host = await createOwnerHost(
        {
          ownerId: "owner",
          holderId: "holder",
          schema: "public",
          session,
          initialization: "fresh",
          registry,
          policy,
          maxActive: fault === "mixed-capacity" ? 1 : 4,
          maxPending: 32,

          now: () =>
            fault === "submillisecond"
              ? new Date(time).toISOString().replace(
                "Z",
                `${String(microsecond).padStart(3, "0")}Z`,
              )
              : new Date(time).toISOString(),
          onError: (error) => errors.push(error),
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
          createTransport: createHypervisor,
        },
        undefined,
        placement === "owner-local"
          ? {
            ...(fault === "mixed-capacity" || localChild
              ? {
                actions: {
                  actionIds: localChild ? ["fixture.child"] : ["fixture.root"],
                  policy: {
                    grants: () => ({ ctx: true, settlement: true }),
                    input() {},
                    collections: () => ({}),
                  },
                  createCapabilities: () => {
                    localActionFactories++;
                    if (localChild) assert.ok(host.snapshot().active >= 2);
                    else assert.equal(host.snapshot().active, 1);
                    return {
                      resources: registry.resources,
                      adapters: registry.adapters,
                    };
                  },
                },
              }
              : {}),
            processors: {
              processorIds: ["fixture.follow"],
              policy: {
                async grants(tx, authority) {
                  if (
                    fault === "predecessor-grant" && authority.phase === "start"
                  ) await mutatePredecessor(tx, authority.binding.deliveryId);
                  if (
                    (fault === "retry-identity" ||
                      fault === "retry-cancellation") &&
                    authority.phase === "current" && !faultInjected
                  ) {
                    const row = (await tx.query(
                      "SELECT status FROM event_deliveries WHERE id=$1",
                      [authority.binding.deliveryId],
                    )).rows[0];
                    if (row?.status === "retry_wait") {
                      faultInjected = true;
                      if (fault === "retry-cancellation") {
                        await tx.query(
                          "UPDATE copilotz_operations SET cancellation_requested_at=now() WHERE operation_id=(SELECT settlement_scope_id FROM event_deliveries WHERE id=$1) AND namespace=$2",
                          [
                            authority.binding.deliveryId,
                            authority.binding.namespace,
                          ],
                        );
                      } else {await tx.query(
                          "UPDATE event_deliveries SET settlement_scope_id=(SELECT settlement_scope_id FROM event_deliveries sibling WHERE sibling.consumer_id='processor:fixture.detached' AND sibling.event_id=event_deliveries.event_id LIMIT 1) WHERE id=$1",
                          [authority.binding.deliveryId],
                        );}
                    }
                  }
                  return { ctx: true, settlement: true };
                },
                async event(tx, assignment, event, data) {
                  policy.processorEvent(tx, assignment, event, data);
                  if (
                    fault === "predecessor-event" &&
                    assignment.attemptOrdinal === 2
                  ) await mutatePredecessor(tx, assignment.deliveryId);
                },
                collections: () => ({}),
              },
              createCapabilities: async () => {
                localProcessorFactories++;
                if (fault === "close-held-factory") {
                  factoryHeld = true;
                  await releaseFactory.promise;
                }
                if (fault === "mixed-capacity") {
                  assert.equal(host.snapshot().active, 1);
                }
                return {
                  resources: registry.resources,
                  adapters: registry.adapters,
                };
              },
            },
          }
          : undefined,
      );
      const listener = mode === "websocket"
        ? await serve({ hypervisor: host.listener })
        : undefined;
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) {
        url.protocol = "ws:";
      }
      const workerOptions = (id: string) => ({
        id,
        transport: url
          ? {
            type: "websocket",
            config: { url, allowInsecureLoopback: true },
          }
          : local,
        capacity: 4,
        hostCalls: { maxConcurrent: 16, timeoutMs: 10_000 },
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
        registry,
        ownerId: "owner",
        namespace: "space",
        worker: workerOptions("execution") as never,
        createCapabilities: () => ({
          resources: registry.resources,
          adapters: registry.adapters,
        }),
        createProcessorCapabilities: () => {
          workerProcessorFactories++;
          if (fault === "mixed-capacity") {
            assert.equal(host.snapshot().active, 1);
          }
          return { resources: registry.resources, adapters: registry.adapters };
        },
      }, createWorker);
      const ingress = createWorker({
        ...workerOptions("ingress"),
        workloads: { unused: () => new Uint8Array() },
      });
      const facade = createOwnerActionCallers({
        actions: registry.actions,
        namespace: "space",
        port: createOwnerConnection({
          ownerId: "owner",
          callHost: ingress.callHost,
        }),
      });
      try {
        await Promise.all([worker.ready, ingress.ready]);
        const firstRoot = facade.actions.root("first", {
          operationKey: "first",
        }).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        if (fault === "close-held-factory") {
          await eventually(() => factoryHeld);
          let closed = false;
          const closing = host.close("stop during local Processor factory")
            .then(() => {
              closed = true;
            });
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(
            closed,
            false,
            "close waits actual noncooperative factory",
          );
          assert.equal(host.snapshot().ready, false);
          assert.ok(host.snapshot().active >= 1);
          assert.equal(firstStarted, false);
          releaseFactory.resolve();
          await closing;
          assert.equal(
            firstStarted,
            false,
            "revoked factory return cannot invoke authored code",
          );
          const held = (await db.query(
            "SELECT status,attempts FROM event_deliveries WHERE consumer_id='processor:fixture.follow'",
          )).rows[0];
          assert.equal(held.status, "leased");
          assert.equal(held.attempts, 1);
          facade.close();
          await firstRoot;
          return;
        }
        if (fault === "held-start") {
          await eventually(() => replyInjected);
          await heldReply.promise;
          assert.equal(firstStarted, false);
          assert.equal(localProcessorFactories, 0);
          const held = (await db.query(
            "SELECT status,attempts,lease_expires_at FROM event_deliveries WHERE consumer_id='processor:fixture.follow'",
          )).rows[0];
          assert.equal(held.status, "leased");
          assert.equal(held.attempts, 1);
          assert.equal(held.lease_expires_at, null);
          assert.ok(host.snapshot().active >= 1);
          releaseReply.resolve();
        }
        assert.equal((await firstRoot).value, "root:first");
        await eventually(() => Promise.resolve(firstStarted));
        const leased =
          (await db.query<{ id: string; lease_expires_at: string }>(
            "SELECT id,lease_expires_at FROM event_deliveries WHERE consumer_id='processor:fixture.follow' AND status='leased'",
          )).rows[0];
        assert.equal(leased.lease_expires_at, null);
        assert.equal(
          (await db.query("SELECT name FROM owner_alarms WHERE name=$1", [
            JSON.stringify(["host.delivery", "space", leased.id]),
          ])).rows.length,
          0,
          "neither placement schedules a job-expiry alarm",
        );
        time += 60_000; // Cross the previous default worker lease without renewal.
        await host.wake();
        assert.equal(
          (await db.query("SELECT attempts FROM event_deliveries WHERE id=$1", [
            leased.id,
          ])).rows[0].attempts,
          1,
        );
        assert.equal(
          (await db.query(
            "SELECT 1 FROM owner_receipts WHERE kind IN ('execution.renew','processor.renew')",
          )).rows.length,
          0,
        );
        const root = (await db.query<{ settlement_scope_id: string }>(
          "SELECT settlement_scope_id FROM event_deliveries WHERE consumer_id='registered:fixture.root'",
        )).rows[0];
        assert.notEqual(
          (await db.query(
            "SELECT state FROM copilotz_operations WHERE operation_id=$1",
            [root.settlement_scope_id],
          )).rows[0].state,
          "completed",
          "ordinary Action output does not certify settled operation",
        );
        await assert.rejects(
          facade.actions.child("publicly-denied", {
            operationKey: "publicly-denied",
          }),
        );
        release.resolve();
        if (fault === "child-ordinal") {
          await eventually(() => faultInjected && host.snapshot().active === 0);
          const parent = (await db.query(
            "SELECT status,attempts FROM event_deliveries WHERE consumer_id='processor:fixture.follow'",
          )).rows[0];
          assert.deepEqual(
            [parent.status, parent.attempts],
            ["retry_wait", 1],
            "changed ordinal is refused and rolled back",
          );
          assert.equal(childRuns.size, 0);
          assert.equal(
            (await db.query(
              "SELECT id FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
            )).rows.length,
            0,
          );
          assert.equal(
            (await db.query(
              "SELECT key FROM owner_receipts WHERE kind='action.child-admit'",
            )).rows.length,
            0,
          );
          assert.equal(host.snapshot().ready, true);
          assert.deepEqual(errors, []);
          return;
        }
        await eventually(async () =>
          (await db.query("SELECT id FROM nodes WHERE id='reply:first'")).rows
              .length === 1 && observed.includes("first")
        );
        await eventually(async () =>
          (await db.query(
            "SELECT state FROM copilotz_operations WHERE operation_id=$1",
            [root.settlement_scope_id],
          )).rows[0].state === "completed"
        );
        const detached =
          (await db.query<{ settlement_scope_id: string; event_id: string }>(
            "SELECT settlement_scope_id,event_id FROM event_deliveries WHERE consumer_id='processor:fixture.detached'",
          )).rows[0];
        assert.notEqual(
          detached.settlement_scope_id,
          root.settlement_scope_id,
        );
        assert.equal(
          (await db.query(
            "SELECT root_event_id FROM copilotz_operations WHERE operation_id=$1",
            [detached.settlement_scope_id],
          )).rows[0].root_event_id,
          detached.event_id,
        );
        await eventually(async () =>
          (await db.query("SELECT id FROM nodes WHERE id='audit:first'")).rows
            .length === 1
        );
        assert.equal(
          (await db.query("SELECT id FROM nodes WHERE id='audit:first'")).rows
            .length,
          1,
        );
        const retryRoot = facade.actions.root("retry", {
          operationKey: "retry",
        }).then(
          (value) => ({ value, error: undefined }),
          (error) => ({ value: undefined, error }),
        );
        if (fault === "held-completion" || fault === "unknown-completion") {
          await eventually(() => replyInjected);
          await heldReply.promise;
          const retry = (await db.query<
            { id: string; attempts: number; available_at: string }
          >("SELECT id,attempts,available_at::text AS available_at FROM event_deliveries WHERE consumer_id='processor:fixture.follow' AND status='retry_wait'"))
            .rows[0];
          assert.ok(retry);
          assert.equal(retry.attempts, 1);
          assert.equal(retryCalls, 1);
          assert.ok(
            host.snapshot().active >= 1,
            "unknown or held reply retains local capacity",
          );
          assert.equal(
            (await db.query(
              "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
              [retry.id],
            )).rows[0].retired,
            true,
          );
          time = new Date(retry.available_at).getTime() + 1;
          if (fault === "unknown-completion") {
            await eventually(() => !host.snapshot().ready);
            await host.wake();
            assert.equal(retryCalls, 1);
            assert.ok(host.snapshot().active >= 1);
            assert.equal(
              (await db.query(
                "SELECT attempts FROM event_deliveries WHERE id=$1",
                [retry.id],
              )).rows[0].attempts,
              1,
            );
            await retryRoot;
            return;
          }
          // This holds the database COMMIT acknowledgement, including the
          // serialized boundary pump; it is not a caller-facing reply shim.
          const waking = host.wake();
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(retryCalls, 1);
          releaseReply.resolve();
          await waking;
          assert.equal((await retryRoot).value, "root:retry");
          await eventually(() => observed.includes("retry"));
          assert.equal(retryCalls, 2);
          await eventually(() => host.snapshot().active === 0);
          assert.equal(host.snapshot().ready, true);
          assert.deepEqual(errors, []);
          return;
        }
        assert.equal((await retryRoot).value, "root:retry");
        if (fault === "retry-identity" || fault === "retry-cancellation") {
          await eventually(async () =>
            faultInjected &&
            (!host.snapshot().ready ||
              (await db.query(
                  "SELECT kind FROM owner_receipts WHERE kind='processor.local-complete' AND result->>'status'='retry_wait'",
                )).rows.length > 0)
          );
          const rows = (await db.query(
            "SELECT d.status,d.attempts,d.consumer_id FROM event_deliveries d WHERE d.consumer_id='processor:fixture.follow' ORDER BY d.created_at DESC LIMIT 1",
          )).rows;
          assert.equal(rows.length, 1);
          assert.equal(
            rows[0].status,
            "leased",
            "policy mutation and attempted completion must roll back",
          );
          assert.equal(rows[0].attempts, 1);
          assert.equal(
            (await db.query(
              "SELECT kind FROM owner_receipts WHERE kind='processor.local-complete' AND result->>'status'='retry_wait'",
            )).rows.length,
            0,
            "no retry receipt from mutated identity",
          );
          assert.equal(retryCalls, 1);
          return;
        }
        await eventually(async () =>
          (await db.query(
            "SELECT id FROM event_deliveries WHERE consumer_id='processor:fixture.follow' AND status='retry_wait'",
          )).rows.length === 1
        );
        const retry = (await db.query<
          {
            id: string;
            available_at: string;
            attempts: number;
            max_attempts: number;
          }
        >("SELECT id,available_at::text AS available_at,attempts,max_attempts FROM event_deliveries WHERE consumer_id='processor:fixture.follow' AND status='retry_wait'"))
          .rows[0];
        assert.equal(host.snapshot().ready, true);
        assert.equal(retry.attempts, 1);
        assert.equal(retry.max_attempts, 3);
        await host.wake();
        assert.equal(retryCalls, 1, "future retry is not dispatched early");
        const alarm = (await db.query<{ due_at: string }>(
          "SELECT due_at FROM owner_alarms WHERE name=$1",
          [JSON.stringify(["host.delivery", "space", retry.id])],
        )).rows[0];
        assert.equal(
          new Date(alarm.due_at).getTime(),
          new Date(retry.available_at).getTime(),
        );
        if (fault === "submillisecond") {
          assert.match(retry.available_at, /\.\d{3}001(?:Z|[+-])/);
          time = new Date(retry.available_at).getTime();
          microsecond = 0;
          await host.wake();
          assert.equal(retryCalls, 1);
          // An unrelated ordinary command also runs withDeliveryAlarms.
          // At this clock value the retry is exactly one microsecond early.
          assert.equal(
            await facade.actions.root("nested", {
              operationKey: "precision-probe",
            }),
            "root:child:nested",
          );
          await eventually(() => host.snapshot().active === 0);
          assert.equal(host.snapshot().ready, true);
          assert.equal(retryCalls, 1);
          assert.equal(
            (await db.query(
              "SELECT attempts FROM event_deliveries WHERE id=$1",
              [retry.id],
            )).rows[0].attempts,
            1,
          );
          microsecond = 1;
          await host.wake();
          await eventually(() => observed.includes("retry"));
          assert.equal(retryCalls, 2);
          await eventually(() => host.snapshot().active === 0);
          assert.equal(host.snapshot().ready, true);
          assert.deepEqual(errors, []);
          return;
        }
        time = new Date(retry.available_at).getTime() + 1;
        await host.wake();
        if (fault === "predecessor-grant" || fault === "predecessor-event") {
          await eventually(() => faultInjected && !host.snapshot().ready);
          assert.equal(
            retryCalls,
            1,
            "mutated predecessor cannot admit attempt two",
          );
          const actual = (await db.query(
            "SELECT status,attempts FROM event_deliveries WHERE id=$1",
            [retry.id],
          )).rows[0];
          assert.equal(actual.status, "retry_wait");
          assert.equal(actual.attempts, 1);
          const history = (await db.query(
            "SELECT retired FROM owner_assignments WHERE delivery_id=$1",
            [retry.id],
          )).rows;
          assert.equal(history.length, 1);
          assert.equal(
            history[0].retired,
            true,
            "predecessor mutation rolls back",
          );
          assert.equal(
            (await db.query(
              "SELECT kind FROM owner_receipts WHERE kind='owner.local-processor-start' AND intent->>'deliveryId'=$1",
              [retry.id],
            )).rows.length,
            1,
          );
          return;
        }
        await eventually(() => observed.includes("retry"));
        assert.equal(retryCalls, 2);
        if (nestedChildren) {
          assert.equal(
            childRuns.get("retry"),
            1,
            "new local Processor attempt reuses the logical child result",
          );
          assert.equal(
            (await db.query(
              "SELECT id FROM events WHERE type='copilotz.owner.action.requested' AND metadata->>'parentDeliveryId'=$1",
              [retry.id],
            )).rows.length,
            1,
          );
        }
        assert.equal(
          (await db.query(
            "SELECT attempts FROM event_deliveries WHERE id=$1",
            [
              retry.id,
            ],
          )).rows[0].attempts,
          2,
        );
        await eventually(() => host.snapshot().active === 0);
        if (fault === "mixed-capacity") {
          assert.equal(localActionFactories, 2);
          assert.equal(localProcessorFactories, 3);
          assert.equal(workerProcessorFactories, 2);
          assert.equal(host.snapshot().ready, true);
          assert.deepEqual(errors, []);
          return;
        }
        assert.equal(
          await facade.actions.root("nested", { operationKey: "nested" }),
          "root:child:nested",
        );
        await eventually(() => host.snapshot().active === 0);
        const nested = (await db.query<
          { parent_run: string; parent_scope: string; child_scope: string }
        >(
          "SELECT e.metadata->>'parentActionRunId' AS parent_run,d.settlement_scope_id AS child_scope,p.settlement_scope_id AS parent_scope FROM event_deliveries d JOIN events e ON e.id=d.event_id JOIN event_deliveries p ON p.id=e.metadata->>'parentDeliveryId' WHERE d.consumer_id='registered:fixture.child' AND e.metadata->>'parentActionRunId' IS NOT NULL",
        )).rows;
        assert.equal(
          nested.length,
          1,
          "direct Action parent identity is captured durably",
        );
        assert.equal(
          nested[0].child_scope,
          nested[0].parent_scope,
          "direct child inherits the actual parent settlement scope",
        );
        const childCount = (await db.query(
          "SELECT id FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
        )).rows.length;
        assert.equal(
          await facade.actions.root("revoked", { operationKey: "revoked" }),
          "root:revoked",
        );
        await eventually(() => Promise.resolve(revokedStarted));
        // Detached work has its own scope. Do not revoke its event policy
        // merely because the independently scheduled local follow is faster.
        await eventually(async () =>
          (await db.query(
            "SELECT d.status FROM event_deliveries d JOIN events e ON e.id=d.event_id WHERE d.consumer_id='processor:fixture.detached' ORDER BY d.created_at DESC LIMIT 1",
          )).rows[0]?.status === "succeeded"
        );
        eventAllowed = false;
        releaseRevoked.resolve();
        await eventually(() => Promise.resolve(replayDenied && childDenied));
        await eventually(() => host.snapshot().active === 0);
        assert.ok(
          policyDenials >= 2,
          "current event policy is rerun before Collection receipt replay and child admission",
        );
        assert.equal(
          (await db.query("SELECT id FROM nodes WHERE id='policy:revoked'"))
            .rows.length,
          1,
        );
        assert.equal(
          (await db.query(
            "SELECT id FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
          )).rows.length,
          childCount,
          "revoked event authority cannot admit another child",
        );
        assert.equal(
          host.snapshot().ready,
          true,
          "ctx refusal preserves safe Processor completion and owner readiness",
        );
        assert.deepEqual(errors, []);
      } catch (error) {
        throw new Error(
          JSON.stringify({
            snapshot: host.snapshot(),
            errors: errors.map((error) => ({
              message: String(error),
              stack: (error as Error).stack,
            })),
            deliveries: (await db.query(
              "SELECT consumer_id,status,attempts,last_error FROM event_deliveries",
            )).rows,
            time: new Date(time).toISOString(),
            alarms:
              (await db.query("SELECT name,due_at FROM owner_alarms")).rows,
          }),
          { cause: error },
        );
      } finally {
        release.resolve();
        releaseRevoked.resolve();
        releaseReply.resolve();
        releaseFactory.resolve();
        facade.close();
        await ingress.stop("fixture finished");
        await worker.close("fixture finished");
        await host.close();
        await listener?.shutdown();
        await db.close();
      }
    },
  );
}
