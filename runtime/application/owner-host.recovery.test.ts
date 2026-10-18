import assert from "node:assert/strict";
import { test } from "node:test";
import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createOwnerCommandBoundary } from "../owner/boundary.ts";
import { createOwnerConnection } from "../owner/connection.ts";
import { encodeOwnerMetadataConstraints } from "../owner/metadata-constraints.ts";
import {
  createOwnerLostActionRecovery,
  OWNER_LOST_ACTION_RECOVERY,
  ownerLostActionKey,
} from "../owner/lost-action.ts";
import { createOwnerOperationSettlement } from "../owner/settlement.ts";
import { createTestOwnerCatalog } from "../testing/owner-catalog.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import { createOwnerHost } from "./owner-host.ts";
import { createOwnerConnectedWorker } from "./owner-worker.ts";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => resolve = yes);
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("lost host fixture timed out")),
          12000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `lost Action ${mode}: real fresh-host history cannot gain an original contract on takeover`,
    { skip: !sourceRoot, timeout: 45000 },
    async () => {
      const { entrypoints } = await resolveOxianSource(sourceRoot!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const db = await createTestDatabase({
        pgliteMemoryProfile: "low-memory",
      });
      const entered = deferred(), release = deferred();
      let oldExecutions = 0, newExecutions = 0;
      const registry = createPluginRegistry({
        actions: {
          work: defineAction({
            id: "work",
            inputSchema: { type: "string" } as const,
            outputSchema: { type: "string" } as const,
            async execute(value: string) {
              oldExecutions++;
              entered.resolve();
              await release.promise;
              return value;
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
        holderId: "first",
        schema: "public",
        initialization: "fresh",
        session: db,
        registry,
        maxActive: 1,
        maxPending: 8,

        policy: {
          ingress: (_tx, context) =>
            context.fence.identity.workerId === "ingress"
              ? {
                namespace: "space",
                principalKey: "api",
                principal: { kind: "developer", actorId: "api" },
                route: { kind: "wrapper", id: "fixture" },
                allowedActions: ["work"],
                actionMetadata: {},
                operationMetadata: {},
                metadataConstraints: encodeOwnerMetadataConstraints({
                  actorId: "api",
                  httpAdmissionKey: "group",
                }),
                group: { key: "group", actorId: "api" },
              }
              : undefined,
          worker: () => ({ ctx: true, settlement: true }),
          input() {},
          collections: () => ({}),
          effectOutcome: () => true,
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
              expiresAtMs: Date.now() + 60000,
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
      const workerConfig = (id: string) => ({
        id,
        transport: url
          ? { type: "websocket", config: { url, allowInsecureLoopback: true } }
          : local,
        capacity: 1,
        hostCalls: { maxConcurrent: 8, timeoutMs: 10000 },
        activate: () => ({
          workerId: id,
          attemptId: crypto.randomUUID(),
          epoch: 1,
        }),
        register: () => ({
          credential: { kind: "registration", capability: "fixture" },
          expiresAtMs: Date.now() + 60000,
        }),
        reconnectDelay: false,
      });
      const worker = createOwnerConnectedWorker({
        registry,
        ownerId: "owner",
        namespace: "space",
        worker: workerConfig("action") as never,
        createCapabilities: () => ({ resources: {}, adapters: {} }),
      }, createWorker);
      const ingress = createWorker({
        ...workerConfig("ingress"),
        workloads: { unused: () => new Uint8Array() },
      });
      let successor: ReturnType<typeof createOwnerCommandBoundary> | undefined;
      try {
        await within(Promise.all([worker.ready, ingress.ready]));
        const connection = createOwnerConnection({
          ownerId: "owner",
          callHost: ingress.callHost,
        });
        const accepted = await connection.callAction({
          actionAlias: "work",
          input: "value",
          operationKey: "lost",
        });
        const reference = accepted.result as {
          deliveryId: string;
          actionRunId: string;
          namespace: string;
        };
        await within(entered.promise);
        const claims = (await db.query<{ result: Record<string, unknown> }>(
          "SELECT result FROM owner_receipts WHERE kind='execution.claim' AND result->>'deliveryId'=$1",
          [reference.deliveryId],
        )).rows;
        assert.equal(claims.length, 1);
        assert.equal(Object.hasOwn(claims[0].result, "contract"), false);
        assert.equal(
          (await db.query(
            "SELECT 1 FROM owner_receipts WHERE kind LIKE 'effect.%'",
          )).rows.length,
          0,
        );
        const convertedRegistry = createPluginRegistry({
          actions: {
            work: defineAction({
              id: "work",
              inputSchema: { type: "string" } as const,
              outputSchema: { type: "string" } as const,
              execute(value: string) {
                newExecutions++;
                return value;
              },
            }),
          },
        });
        const catalog = createTestOwnerCatalog(db, "public");
        const settlement = createOwnerOperationSettlement({
          ownerId: "owner",
          schema: "public",
          session: db,
          catalog,
          authorizeControl: () => false,
          selectDrains: () => [],
          authorizeDrain: () => false,
          drain: () => Promise.resolve(false),
          wake() {},
        });
        const executor: DeliveryExecutor = {
          ownership: "injected_dispatcher",
          workload: "no-recovery-execution",
          workloads: {},
          scheduleDelivery() {
            assert.fail("blocked recovery must not schedule");
          },
          dispatchWork: () =>
            Promise.reject(new Error("no recovery execution")),
          dispatchDelivery: () =>
            Promise.reject(new Error("no recovery execution")),
          dispatchRecoverable: () =>
            Promise.reject(new Error("no recovery execution")),
          settleOutputs: () => Promise.resolve(),
          awaitScopeProgress: () => Promise.resolve(false),
          shutdown: () => Promise.resolve(),
        };
        const recovery = createOwnerLostActionRecovery({
          ownerId: "owner",
          schema: "public",
          session: db,
          registry: convertedRegistry,
          catalog,
          executor,
          authorizeControl: (_tx, caller) =>
            caller.principal.kind === "owner-control",
          authorizeRecoveryTransition: () => true,
          scheduleSettlement: (context, scope) =>
            settlement.schedule(context, scope),
        });
        successor = createOwnerCommandBoundary({
          ownerId: "owner",
          holderId: "second",
          schema: "public",
          session: db,
          handlers: recovery.handlers,
          authorize: recovery.authorize,
          authenticateReceipt() {
            throw new Error("no generic receipts");
          },
        });
        await successor.acquire(1);
        const before =
          (await db.query("SELECT * FROM event_deliveries WHERE id=$1", [
            reference.deliveryId,
          ])).rows;
        assert.equal(before[0].status, "leased");
        assert.equal(before[0].attempts, 1);
        const target = { namespace: "space", deliveryId: reference.deliveryId };
        const result = await successor.execute({
          principal: {
            kind: "owner-control",
            ownerId: "owner",
            epoch: 2,
            holderId: "second",
          },
          ownerEpoch: 2,
        }, {
          kind: OWNER_LOST_ACTION_RECOVERY,
          domain: "occurrence",
          key: ownerLostActionKey("owner", 2, target, "test"),
          intent: { ...target, occurrence: "test" },
        });
        assert.deepEqual(result.result, {
          ...target,
          disposition: "blocked",
          reason: "original_contract_unproven",
        });
        assert.deepEqual(
          (await db.query("SELECT * FROM event_deliveries WHERE id=$1", [
            reference.deliveryId,
          ])).rows,
          before,
        );
        assert.equal(oldExecutions, 1);
        assert.equal(newExecutions, 0);
        assert.ok(
          (await db.query(
            "SELECT 1 FROM owner_alarms WHERE name LIKE '%reconciliation%'",
          )).rows.length > 0,
        );
      } finally {
        release.resolve();
        await ingress.stop("done");
        await worker.close("done");
        await within(host.close());
        successor?.stop();
        await listener?.shutdown();
        await db.close();
      }
    },
  );
}
