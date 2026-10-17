/** Actual named preparation reverse calls and registered child execution.
 * The occupied parent workload is test scaffolding, not public ctx.prepare or
 * production owner-host/channel activation. All provider I/O is absent. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import {
  createOwnerConnectedWorker,
  OWNER_ACTION_WORKLOAD,
} from "../application/owner-worker.ts";
import {
  createRegisteredOwnerExecutionPort,
  ownerRenewalKey,
} from "../execution/owner-port.ts";
import { createExecutionHeartbeat } from "../execution/execution-heartbeat.ts";
import type { OwnerChildActionReference } from "../execution/child-action-port.ts";
import type { RegisteredExecutionReference } from "../execution/registered-worker.ts";
import type { OwnerCaller } from "./boundary.ts";
import type { OwnerActionAssignmentBinding } from "./assignments.ts";
import type { OwnerExecutionAssignment } from "./execution.ts";
import {
  createOwnerConnection,
  createOwnerWorkerCallAdmission,
  type OwnerHostCaller,
  type OwnerWorkerCallContext,
} from "./connection.ts";
import { fixture, namespace, ownerId } from "./preparation.fixture.test.ts";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
async function within<T>(
  promise: Promise<T>,
  label = "preparation transport",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function eventually(check: () => Promise<boolean>) {
  await within((async () => {
    while (!await check()) await new Promise((done) => setTimeout(done, 10));
  })());
}
type Fence = OwnerWorkerCallContext["fence"];
type Binding = {
  fence: Fence;
  operationId: string;
  assignment: OwnerExecutionAssignment;
  started: boolean;
  committed: boolean;
};
const root = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
for (const mode of ["in-process", "websocket"] as const) {
  test(
    `named preparation ${mode}: lifecycle capture, real child, immutable replay and current input/result gates`,
    {
      skip: !root,
      timeout: 40_000,
    },
    async () => {
      const { entrypoints } = await resolveOxianSource(root!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { createWorker } = await import(entrypoints["./worker"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const bindings = new Map<string, Binding>();
      function current(binding: Binding): boolean {
        try {
          return host.sessions.assertCurrent(binding.fence).phase === "ready";
        } catch {
          return false;
        }
      }
      const who = (binding: Binding): OwnerCaller => ({
        principal: {
          kind: "worker",
          workerId: binding.fence.identity.workerId,
        },
        ownerEpoch: 1,
        assignmentId: binding.assignment.assignmentId,
        sessionId: binding.fence.connectionId,
        workerAttemptId: binding.fence.identity.attemptId,
        sessionGeneration: binding.fence.sessionGeneration,
        parentOperationId: binding.operationId,
        dispatchAttemptId: binding.assignment.dispatchAttemptId,
      });
      const f = await fixture({
        deferParentClaim: true,
        leaseMs: 1500,
        now: () => new Date().toISOString(),
        transportAuthority: {
          caller(assignment) {
            const binding = bindings.get(assignment.assignmentId);
            assert(binding);
            return who(binding);
          },
          isCurrentStarted(caller) {
            const binding = bindings.get(String(caller.assignmentId));
            return !!binding && binding.started && current(binding) &&
              isDeepStrictEqual(caller, who(binding));
          },
          authenticateReceipt(caller) {
            return caller.principal.kind === "worker" &&
              [...bindings.values()].some((binding) =>
                binding.fence.identity.workerId ===
                  (caller.principal as { workerId: string }).workerId &&
                current(binding)
              );
          },
        },
      });
      const pendingChildren = new Map<string, OwnerChildActionReference>();
      const ready = deferred<ReturnType<typeof createOwnerConnection>>();
      const finish = deferred();
      const local = {
        type: "in-process" as const,
        config: { topic: crypto.randomUUID() },
      };
      const admission = createOwnerWorkerCallAdmission({
        resolveOwner: (id) => id === ownerId ? f.boundary : undefined,
        authorizeReadiness(context) {
          try {
            return host.sessions.assertCurrent(context.fence).phase === "ready";
          } catch {
            return false;
          }
        },
        resolveAssignment(context) {
          const binding = bindings.get(context.parent?.streamId ?? "");
          if (
            !binding || !binding.started || !current(binding) ||
            context.parent?.operationId !== binding.operationId ||
            !isDeepStrictEqual(context.fence, binding.fence)
          ) return undefined;
          return {
            ownerId,
            caller: who(binding),
            ctxGranted: f.state.ctx,
            settlementGranted: true,
          };
        },
      });
      const host = createHypervisor({
        transports: mode === "in-process"
          ? [local]
          : [{ type: "websocket", config: { path: "/workers" } }],
        workerCalls: {
          ...admission,
          timeoutMs: 3000,
          maxConcurrent: 4,
          maxPerConnection: 2,
        },
        admit: ({ identity, credential, workloads, capacity }: {
          identity: Fence["identity"];
          credential: { kind: string };
          workloads: readonly string[];
          capacity: number;
        }) => ({
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
      }, {
        async onWorkAssigned(
          context: {
            operationId: string;
            workload: string;
            metadata: Record<string, unknown>;
            assignment: { streamId: string; fence: Fence };
          },
        ) {
          const { streamId, fence } = context.assignment;
          const ref = context.workload === "fixture.prepare"
            ? f.rootRef
            : pendingChildren.get(String(context.metadata.token));
          assert(ref, "only host-issued dispatch tokens select a child");
          const coordinates = {
            workerId: fence.identity.workerId,
            sessionId: fence.connectionId,
          };
          const assignment = context.workload === "fixture.prepare"
            ? f.bindParent(streamId, coordinates)
            : f.assign(ref, streamId, coordinates);
          const binding: Binding = {
            fence: structuredClone(fence),
            operationId: context.operationId,
            assignment,
            started: false,
            committed: false,
          };
          bindings.set(streamId, binding);
          const durable: OwnerActionAssignmentBinding = {
            placement: "worker",
            workerId: coordinates.workerId,
            workerAttemptId: fence.identity.attemptId,
            sessionGeneration: fence.sessionGeneration,
            sessionId: coordinates.sessionId,
            parentOperationId: context.operationId,
            assignmentId: streamId,
            dispatchAttemptId: assignment.dispatchAttemptId,
            namespace,
            sourceEventId: ref.eventId,
            deliveryId: ref.deliveryId,
            actionId: ref.actionId,
            executionId: ref.executionId,
          };
          await f.bindTransport(durable); // Actual fenced commit precedes Work Open/Start.
          binding.committed = true;
        },
        onStart(context: { streamId: string; fence: Fence }) {
          const binding = bindings.get(context.streamId);
          assert(binding);
          assert.deepEqual(context.fence, binding.fence);
          assert.equal(binding.committed, true);
          binding.started = true;
        },
        onComplete(context: { streamId: string }) {
          const binding = bindings.get(context.streamId);
          if (binding) binding.started = false;
        },
      });
      const listener = mode === "websocket"
        ? await serve({ hypervisor: host })
        : undefined;
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      const transport = url
        ? {
          type: "websocket" as const,
          config: { url, allowInsecureLoopback: true },
        }
        : local;
      const parent = createWorker({
        id: "preparer",
        transport,
        capacity: 1,
        hostCalls: { maxConcurrent: 2, timeoutMs: 3000 },
        activate: () => ({
          workerId: "preparer",
          attemptId: "preparer-attempt",
          epoch: 1,
        }),
        register: () => ({
          credential: { kind: "registration", capability: "fixture" },
          expiresAtMs: Date.now() + 60_000,
        }),
        workloads: {
          "fixture.prepare": async (
            context: {
              streamId: string;
              input: ReadableStream<Uint8Array>;
              signal: AbortSignal;
              callHost: OwnerHostCaller;
            },
          ) => {
            try {
              await context.input.cancel();
              const connection = createOwnerConnection({
                ownerId,
                callHost: context.callHost,
              });
              const port = createRegisteredOwnerExecutionPort({
                ownerId,
                namespace,
                port: connection,
              });
              const claimed = await port.claim({
                assignmentId: context.streamId,
                sessionId: parent.snapshot().connectionId,
              }, { signal: context.signal });
              const started = performance.now();
              const projection = await port.project(claimed.result, {
                signal: context.signal,
              });
              const heartbeat = createExecutionHeartbeat<
                RegisteredExecutionReference
              >({
                reference: claimed.result,
                lease: projection.lease,
                started,
                renew: (reference, options) => port.renew(reference, options),
                validate(result, expected) {
                  const { lease: _lease, ...reference } = result;
                  assert.deepEqual(reference, expected);
                },
                fail(error) {
                  finish.reject(error);
                },
              });
              ready.resolve(connection);
              try {
                await finish.promise;
                heartbeat.check();
                await heartbeat.stop();
                await port.complete(claimed.result, {
                  status: "completed",
                  output: null,
                }, { signal: context.signal });
                return new TextEncoder().encode("parent completed");
              } finally {
                await heartbeat.stop();
              }
            } catch (error) {
              ready.reject(error);
              throw error;
            }
          },
        },
      });
      const child = createOwnerConnectedWorker({
        registry: f.registry,
        ownerId,
        namespace,
        createCapabilities: () => ({ resources: {}, adapters: {} }),
        worker: {
          id: "child",
          transport,
          capacity: 1,
          ...{ hostCalls: { maxConcurrent: 2, timeoutMs: 3000 } },
          activate: () => ({
            workerId: "child",
            attemptId: "child-attempt",
            epoch: 1,
          }),
          register: () => ({
            credential: { kind: "registration", capability: "fixture" },
            expiresAtMs: Date.now() + 60_000,
          }),
        },
      }, createWorker);
      try {
        await within(Promise.all([parent.ready, child.ready]), "workers ready");
        const handle = await host.dispatch({
          workload: "fixture.prepare",
          target: { workerId: "preparer" },
          deadlineAtMs: Date.now() + 20_000,
        });
        const parentOutput = new Response(handle.output).text();
        void parentOutput.catch(() => undefined);
        void handle.completed.catch(ready.reject);
        const connection = await within(
          ready.promise,
          "parent claim and projection",
        );
        const first = await connection.prepareChildAction(f.request());
        const ref = first.result as OwnerChildActionReference;
        assert.equal(first.status, "committed");
        const replacement = await f.addAsset("replacement", "new body");
        await f.db.query("UPDATE nodes SET data=$1 WHERE id='message-1'", [{
          title: "Changed",
          content: [replacement],
        }]);
        f.state.renderVersion = "changed";
        f.style.prefix = "Changed:";
        const counts = [
          f.state.rendered,
          f.state.projected,
          f.state.resourceProjected,
          f.state.mapped,
        ];
        assert.deepEqual(await connection.prepareChildAction(f.request()), {
          status: "duplicate",
          result: ref,
        });
        assert.deepEqual([
          f.state.rendered,
          f.state.projected,
          f.state.resourceProjected,
          f.state.mapped,
        ], counts);
        const runChild = async (reference: OwnerChildActionReference) => {
          const token = crypto.randomUUID();
          pendingChildren.set(token, reference);
          const work = await host.dispatch({
            workload: OWNER_ACTION_WORKLOAD,
            target: { workerId: "child" },
            metadata: { token },
            deadlineAtMs: Date.now() + 5000,
          });
          const output = new Response(work.output).text();
          try {
            return await within(Promise.all([output, work.completed]));
          } finally {
            pendingChildren.delete(token);
          }
        };
        await runChild(ref);
        assert.equal(f.state.executed, 1);
        const query = { parent: f.parentRef(), reference: ref };
        assert.deepEqual(await connection.childActionResult(query), {
          status: "completed",
          output: { text: "Reply: Title body original" },
        });
        f.state.originalAllowed = false;
        await assert.rejects(connection.childActionResult(query));
        f.state.originalAllowed = true;
        const second =
          (await connection.prepareChildAction(f.request("blocked-input")))
            .result as OwnerChildActionReference;
        let inputChecks = 0;
        f.state.duringInputAuthorization = (assignment) => {
          if (
            assignment.deliveryId === second.deliveryId && ++inputChecks === 2
          ) f.state.originalAllowed = false;
        };
        await assert.rejects(runChild(second));
        assert.equal(inputChecks, 2);
        assert.equal(f.state.executed, 1);
        const blocked = await f.store.getDelivery(second.deliveryId);
        assert.equal(blocked!.attempts, 1);
        assert.equal(blocked!.status, "leased");
        assert.equal(
          await f.store.getEventByDeduplicationId(
            namespace,
            `${second.executionId}:action:terminal`,
          ),
          null,
        );
        f.state.originalAllowed = true;
        f.state.duringInputAuthorization = undefined;
        assert.deepEqual(await connection.prepareChildAction(f.request()), {
          status: "duplicate",
          result: ref,
        });
        await eventually(async () =>
          (await f.db.query(
            "SELECT 1 FROM owner_receipts WHERE owner=$1 AND kind='execution.renew' AND key=$2",
            [
              ownerId,
              ownerRenewalKey(
                ownerId,
                f.parent.assignmentId,
                f.parent.sessionId,
                1,
              ),
            ],
          )).rows.length > 0
        );
        assert.equal(parent.snapshot().connectionId, f.parent.sessionId);
        assert.equal(child.snapshot().ownerReady, true);
        finish.resolve();
        assert.equal(await within(parentOutput), "parent completed");
        await within(handle.completed);
        assert.equal(
          (await f.db.query(
            "SELECT 1 FROM owner_receipts WHERE kind='action.child-prepare'",
          )).rows.length,
          2,
        );
      } finally {
        finish.resolve();
        await Promise.allSettled([
          parent.stop("fixture closed"),
          child.close("fixture closed"),
        ]);
        await host.shutdown("fixture closed");
        await listener?.shutdown();
        await f.close();
      }
    },
  );
}
