import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
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
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `owner whole-plugin ${mode}: Collection → Processor → child Action, detached scope and due retry`,
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
      const release = deferred();
      const releaseRevoked = deferred();
      let revokedStarted = false;
      let eventAllowed = true;
      let replayDenied = false;
      let childDenied = false;
      let policyDenials = 0;
      let firstStarted = false;
      let time = Date.now();
      let retryCalls = 0;
      const errors: unknown[] = [];
      const observed: string[] = [];
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
                if (value === "retry" && ++retryCalls === 1) {
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
                const callChild = ctx.actions.child as (
                  input: string,
                  options: { operationKey: string },
                ) => Promise<unknown>;
                const result = await callChild(value, {
                  operationKey: "child",
                });
                assert.equal(result, `child:${value}`);
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
        child(_tx: unknown, parent: { namespace: string }, actionId: string) {
          assert.equal(parent.namespace, "space");
          assert.equal(actionId, "fixture.child");
        },
        effectOutcome: () => false,
        effectNotStarted: () => false,
      };
      const host = await createOwnerHost({
        ownerId: "owner",
        holderId: "holder",
        schema: "public",
        session: db,
        initialization: "fresh",
        registry,
        policy,
        maxActive: 4,
        maxPending: 32,
        leaseMs: 3000,
        now: () => new Date(time).toISOString(),
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
      });
      const listener = mode === "websocket"
        ? await serve({ hypervisor: host.listener })
        : undefined;
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      const workerOptions = (id: string) => ({
        id,
        transport: url
          ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
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
        createProcessorCapabilities: () => ({
          resources: registry.resources,
          adapters: registry.adapters,
        }),
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
        assert.equal(
          await facade.actions.root("first", { operationKey: "first" }),
          "root:first",
        );
        await eventually(() => Promise.resolve(firstStarted));
        const leased =
          (await db.query<{ id: string; lease_expires_at: string }>(
            "SELECT id,lease_expires_at FROM event_deliveries WHERE consumer_id='processor:fixture.follow' AND status='leased'",
          )).rows[0];
        const leaseAlarm = async () =>
          (await db.query<{ due_at: string }>(
            "SELECT due_at FROM owner_alarms WHERE name=$1",
            [JSON.stringify(["host.delivery", "space", leased.id])],
          )).rows[0].due_at;
        assert.equal(
          new Date(await leaseAlarm()).getTime(),
          new Date(leased.lease_expires_at).getTime(),
          "active delivery alarm uses actual lease expiry, not stale availability",
        );
        time += 1000;
        await eventually(async () =>
          new Date(
            (await db.query<{ lease_expires_at: string }>(
              "SELECT lease_expires_at FROM event_deliveries WHERE id=$1",
              [leased.id],
            )).rows[0].lease_expires_at,
          ).getTime() > new Date(leased.lease_expires_at).getTime()
        );
        const renewed = (await db.query<{ lease_expires_at: string }>(
          "SELECT lease_expires_at FROM event_deliveries WHERE id=$1",
          [leased.id],
        )).rows[0];
        assert.equal(
          new Date(await leaseAlarm()).getTime(),
          new Date(renewed.lease_expires_at).getTime(),
          "renewal moves the durable alarm with the lease",
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
        assert.notEqual(detached.settlement_scope_id, root.settlement_scope_id);
        assert.equal(
          (await db.query(
            "SELECT root_event_id FROM copilotz_operations WHERE operation_id=$1",
            [detached.settlement_scope_id],
          )).rows[0].root_event_id,
          detached.event_id,
        );
        assert.equal(
          (await db.query("SELECT id FROM nodes WHERE id='audit:first'")).rows
            .length,
          1,
        );
        assert.equal(
          await facade.actions.root("retry", { operationKey: "retry" }),
          "root:retry",
        );
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
        >("SELECT id,available_at,attempts,max_attempts FROM event_deliveries WHERE consumer_id='processor:fixture.follow' AND status='retry_wait'"))
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
        time = new Date(retry.available_at).getTime() + 1;
        await host.wake();
        await eventually(() => observed.includes("retry"));
        assert.equal(retryCalls, 2);
        assert.equal(
          (await db.query("SELECT attempts FROM event_deliveries WHERE id=$1", [
            retry.id,
          ])).rows[0].attempts,
          2,
        );
        await eventually(() => host.snapshot().active === 0);
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
