import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { createOwnerConnection } from "../owner/connection.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import { createOwnerActionCallers } from "./owner-actions.ts";
import { createOwnerHost } from "./owner-host.ts";
import { createOwnerConnectedWorker } from "./owner-worker.ts";

async function eventually(check: () => boolean | Promise<boolean>) {
  const until = Date.now() + 10_000;
  while (!await check()) {
    if (Date.now() >= until) throw new Error("Capacity fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  for (const maxActive of [1, 2]) {
    test(
      `owner capacity ${mode}/${maxActive}: bounded child wait preserves owner and durable obligations`,
      { skip: !sourceRoot, timeout: 30_000 },
      async () => {
        const { entrypoints } = await resolveOxianSource(sourceRoot!);
        const { createHypervisor } = await import(entrypoints["./hypervisor"]);
        const { createWorker } = await import(entrypoints["./worker"]);
        const { serve } = await import(entrypoints["./adapters/node"]);
        const db = await createTestDatabase({
          pgliteMemoryProfile: "low-memory",
        });
        const errors: unknown[] = [];
        const childResults: string[] = [];
        let parentWaitMs = 0;
        let parentChildError: string | undefined;
        const registry = createPluginRegistry({
          actions: {
            parent: defineAction({
              id: "fixture.parent",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              async execute(value: string, ctx: ActionContext) {
                const started = Date.now();
                try {
                  const result = await ctx.actions.child(value, {
                    operationKey: "nested",
                  });
                  return `unexpected:${result}`;
                } catch (error) {
                  parentWaitMs = Date.now() - started;
                  parentChildError = (error as { code?: string }).code;
                  return `bounded:${
                    (error as { code?: string }).code ?? "refused"
                  }`;
                }
              },
            }),
            other: defineAction({
              id: "fixture.other",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              execute: (value: string) => `other:${value}`,
            }),
            child: defineAction({
              id: "fixture.child",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              execute(value: string) {
                childResults.push(value);
                return `child:${value}`;
              },
            }),
          },
        });
        const local = {
          type: "in-process" as const,
          config: { topic: crypto.randomUUID() },
        };
        const host = await createOwnerHost({
          ownerId: "owner",
          holderId: "holder",
          schema: "public",
          session: db,
          initialization: "fresh",
          registry,
          maxActive,
          maxPending: 8,
          dispatchWaitMs: 100,
          onError: (error) => errors.push(error),
          policy: {
            ingress: (_tx, context) =>
              context.fence.identity.workerId === "ingress"
                ? {
                  namespace: "space",
                  principalKey: "api:fixture",
                  principal: { actorId: "api:fixture" },
                  route: { kind: "wrapper", id: "parents-only" },
                  allowedActions: ["parent", "other"],
                  actionMetadata: {},
                  operationMetadata: { tenant: "space" },
                  metadataConstraints: encodeOwnerMetadataConstraints({
                    tenant: "space",
                    actorId: "api:fixture",
                  }),
                  group: { key: "fixture", actorId: "api:fixture" },
                }
                : undefined,
            worker: () => ({ ctx: true, settlement: true }),
            input() {},
            collections: () => ({}),
            child(_tx, parent, actionId) {
              assert.equal(parent.namespace, "space");
              assert.equal(actionId, "fixture.child");
            },
            effectOutcome: () => false,
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
            ? {
              type: "websocket",
              config: { url, allowInsecureLoopback: true },
            }
            : local,
          capacity: 1,
          hostCalls: { maxConcurrent: 8, timeoutMs: 10_000 },
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
          childWaitMs: 800,
          createCapabilities: () => ({ resources: {}, adapters: {} }),
        }, createWorker);
        const ingress = createWorker({
          ...workerOptions("ingress"),
          workloads: { unused: () => new Uint8Array() },
        });
        const facade = createOwnerActionCallers({
          actions: registry.actions,
          namespace: "space",
          maxWaitMs: 10_000,
          port: createOwnerConnection({
            ownerId: "owner",
            callHost: ingress.callHost,
          }),
        });
        try {
          await Promise.all([worker.ready, ingress.ready]);
          const parent = facade.actions.parent("first", {
            operationKey: "first",
          }).then(
            (value) => ({ value, error: undefined }),
            (error) => ({ value: undefined, error }),
          );
          let concurrent: Promise<unknown> | undefined;
          if (maxActive === 2) {
            await eventually(async () =>
              (await db.query(
                "SELECT id FROM event_deliveries WHERE consumer_id='registered:fixture.child' AND status='pending'",
              )).rows.length === 1
            );
            const child =
              (await db.query<{ id: string; settlement_scope_id: string }>(
                "SELECT id,settlement_scope_id FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
              )).rows[0];
            assert.equal(
              (await db.query("SELECT name FROM owner_alarms WHERE name=$1", [
                JSON.stringify(["host.delivery", "space", child.id]),
              ])).rows.length,
              1,
            );
            // The parent occupies the only worker slot. Child admission was durable,
            // but a concurrent root and this child cannot assume reserved capacity.
            concurrent = facade.actions.other("concurrent", {
              operationKey: "concurrent",
            });
            void concurrent.catch(() => undefined);
            await new Promise((resolve) => setTimeout(resolve, 150));
            assert.equal(
              host.snapshot().ready,
              true,
              "admission timeout does not kill an opened parent workload",
            );
            assert.equal(childResults.length, 0);
            assert.ok(
              errors.some((error) => String(error).includes("capacity")),
              "actual transport refused occupied worker capacity",
            );
            assert.equal(
              (await db.query(
                "SELECT status FROM event_deliveries WHERE id=$1",
                [child.id],
              )).rows[0].status,
              "pending",
            );
            assert.equal(
              (await db.query("SELECT name FROM owner_alarms WHERE name=$1", [
                JSON.stringify(["host.delivery", "space", child.id]),
              ])).rows.length,
              1,
              "bounded dispatch refusal preserves durable child alarm",
            );
            assert.notEqual(
              (await db.query(
                "SELECT state FROM copilotz_operations WHERE operation_id=$1",
                [child.settlement_scope_id],
              )).rows[0].state,
              "completed",
            );
          }
          const result = await parent;
          assert.equal(
            result.error?.code,
            "action_failed",
            "a failed tracked child prevents parent success even when caught",
          );
          assert.equal(host.snapshot().ready, true);
          if (maxActive === 1) {
            assert.equal(
              (await db.query(
                "SELECT id FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
              )).rows.length,
              0,
              "capacity-one refuses before child admission",
            );
            assert.deepEqual(childResults, []);
            assert.ok(
              parentWaitMs < 800,
              "full host capacity is refused without occupying a child wait",
            );
          } else {
            assert.equal(parentChildError, "action_wait_interrupted");
            assert.ok(
              parentWaitMs >= 700,
              "opened parent outlives the dispatch-admission timer",
            );
            assert.equal(await concurrent, "other:concurrent");
            await host.wake();
            await eventually(() =>
              childResults.length === 1 && host.snapshot().active === 0
            );
            assert.deepEqual(childResults, ["first"]);
            assert.equal(
              (await db.query(
                "SELECT id FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
              )).rows.length,
              1,
              "bounded waiting never repeats child admission",
            );
            const terminal = (await db.query(
              "SELECT status FROM event_deliveries WHERE consumer_id='registered:fixture.child'",
            )).rows[0];
            assert.equal(terminal.status, "succeeded");
          }
          assert.equal(host.snapshot().ready, true);
        } catch (error) {
          throw new Error(
            JSON.stringify({
              snapshot: host.snapshot(),
              parentWaitMs,
              errors: errors.map(String),
              deliveries: (await db.query(
                "SELECT consumer_id,status,attempts,last_error FROM event_deliveries",
              )).rows,
              alarms:
                (await db.query("SELECT name,due_at FROM owner_alarms")).rows,
            }),
            { cause: error },
          );
        } finally {
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
}
