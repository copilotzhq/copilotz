/** Opt-in selected-sibling evidence for the actual database-free worker wrapper.
 * The postcommit observer uses the existing legacy Processor executor; converting
 * all Processor execution to owner-only persistence remains a separate task. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveOxianSource } from "../../scripts/test-owner-connected.mjs";
import {
  createOwnerConnectedWorker,
  OWNER_ACTION_WORKLOAD,
} from "../application/owner-worker.ts";
import type { ActionContext } from "../actions/types.ts";
import type { OwnerCaller } from "./boundary.ts";
import {
  createOwnerWorkerCallAdmission,
  type OwnerWorkerCallContext,
} from "./connection.ts";
import { deferred, fixture, within } from "./execution.fixture.test.ts";

type Fence = OwnerWorkerCallContext["fence"];
type Assigned = Readonly<
  { operationId: string; assignment: { fence: Fence; streamId: string } }
>;
const sourceRoot = process.env.COPILOTZ_OXIAN_SOURCE_ROOT;
const modes = [
  "committed",
  "ctx-revoked",
  "stale-admitted-parent",
  "ambiguous-claim",
  "readiness-denied",
] as const;
for (const transport of ["in-process", "websocket"] as const) {
  for (const mode of modes) {
    test(`registered owner worker ${transport}: ${mode}`, {
      skip: !sourceRoot,
      timeout: 45_000,
    }, async () => {
      const { entrypoints } = await resolveOxianSource(sourceRoot!);
      const { createHypervisor } = await import(entrypoints["./hypervisor"]);
      const { serve } = await import(entrypoints["./adapters/node"]);
      const readinessReached = deferred();
      const readinessRelease = deferred();
      const actionReached = deferred();
      const actionRelease = deferred();
      const completionAdmitted = deferred();
      const completionRelease = deferred();
      let deniedMutation = false;
      let lostClaim = false;
      let completionWithRevokedCtx = false;
      const reverseReplies: { workload: string; response: unknown }[] = [];
      const f = await fixture({
        async afterAction(ctx: ActionContext) {
          if (mode !== "ctx-revoked") return;
          actionReached.resolve();
          await actionRelease.promise;
          try {
            await ctx.transaction(
              ({ collections }) =>
                collections.notes.create({
                  id: "denied",
                  title: "should not commit",
                }),
              { operationKey: "denied" },
            );
          } catch {
            deniedMutation = true;
          }
        },
        async validateCaller(tx, caller: OwnerCaller) {
          const current = await tx.query(
            `SELECT 1 FROM fixture_parent_bindings p
            JOIN fixture_sessions s ON s.connection_id=p.connection_id
            WHERE p.stream_id=$1 AND p.operation_id=$2 AND p.connection_id=$3
              AND p.session_generation=$4 AND p.worker_attempt_id=$5
              AND s.worker_id=$6 AND s.worker_attempt_id=$5 AND s.session_generation=$4
              AND s.live=TRUE AND p.live=TRUE FOR SHARE OF p,s`,
            [
              caller.assignmentId,
              caller.parentOperationId,
              caller.sessionId,
              caller.sessionGeneration,
              caller.workerAttemptId,
              caller.workerId,
            ],
          );
          if (current.rows.length !== 1) {
            throw Object.assign(
              new Error("current transport assignment refused"),
              { code: "ActionOwnershipLost" },
            );
          }
        },
      });
      await f.db.query(
        `CREATE TABLE fixture_sessions(connection_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL,
        worker_attempt_id TEXT NOT NULL, session_generation INTEGER NOT NULL, live BOOLEAN NOT NULL)`,
      );
      await f.db.query(
        `CREATE TABLE fixture_parent_bindings(stream_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
        connection_id TEXT NOT NULL, worker_attempt_id TEXT NOT NULL, session_generation INTEGER NOT NULL, live BOOLEAN NOT NULL)`,
      );
      const identity = {
        workerId: "worker",
        attemptId: crypto.randomUUID(),
        epoch: 1,
      };
      const admission = createOwnerWorkerCallAdmission({
        resolveOwner: (id) => id === "owner" ? f.boundary : undefined,
        async authorizeReadiness(context, ownerId) {
          readinessReached.resolve();
          if (mode === "committed") await readinessRelease.promise;
          const found = await f.db.query(
            `SELECT 1 FROM fixture_sessions s JOIN owner_epochs e ON e.owner=$1
            WHERE s.connection_id=$2 AND s.worker_id=$3 AND s.worker_attempt_id=$4
              AND s.session_generation=$5 AND s.live=TRUE AND e.epoch=1 AND e.holder='holder'`,
            [
              ownerId,
              context.fence.connectionId,
              context.fence.identity.workerId,
              context.fence.identity.attemptId,
              context.fence.sessionGeneration,
            ],
          );
          return found.rows.length === 1 && f.boundary.state === "acquired";
        },
        async resolveAssignment(context) {
          const parent = context.parent;
          if (!parent || parent.workload !== OWNER_ACTION_WORKLOAD) {
            return undefined;
          }
          const rows = await f.db.query<
            {
              binding: { dispatchAttemptId: string };
              ctx_granted: boolean;
              settlement_granted: boolean;
            }
          >(
            `SELECT a.binding,a.ctx_granted,a.settlement_granted
            FROM fixture_parent_bindings p JOIN fixture_assignments a ON a.assignment_id=p.stream_id
            JOIN fixture_sessions s ON s.connection_id=p.connection_id
            WHERE p.stream_id=$1 AND p.operation_id=$2 AND p.connection_id=$3
              AND p.worker_attempt_id=$4 AND p.session_generation=$5 AND p.live=TRUE
              AND s.live=TRUE AND s.session_generation=$5 AND s.worker_attempt_id=$4
              AND a.session_id=$3 AND a.worker_id=$6 AND a.live=TRUE`,
            [
              parent.streamId,
              parent.operationId,
              context.fence.connectionId,
              context.fence.identity.attemptId,
              context.fence.sessionGeneration,
              context.fence.identity.workerId,
            ],
          );
          const row = rows.rows[0];
          if (!row) return undefined;
          if (
            context.workload === "copilotz.owner.complete" && !row.ctx_granted
          ) completionWithRevokedCtx = true;
          return {
            ownerId: "owner",
            ctxGranted: row.ctx_granted,
            settlementGranted: row.settlement_granted,
            caller: {
              workerId: context.fence.identity.workerId,
              ownerEpoch: 1,
              assignmentId: parent.streamId,
              sessionId: context.fence.connectionId,
              dispatchAttemptId: row.binding.dispatchAttemptId,
              sourceEventId: f.source.event.id,
              parentOperationId: parent.operationId,
              sessionGeneration: context.fence.sessionGeneration,
              workerAttemptId: context.fence.identity.attemptId,
            },
          };
        },
      });
      const local = {
        type: "in-process" as const,
        config: { topic: crypto.randomUUID() },
      };
      const host = createHypervisor({
        transports: transport === "in-process"
          ? [local]
          : [{ type: "websocket", config: { path: "/workers" } }],
        workerCalls: {
          ...admission,
          async admit(context: OwnerWorkerCallContext) {
            const handler = await admission.admit(context);
            if (!handler) return undefined;
            return async (input: Parameters<typeof handler>[0]) => {
              if (
                mode === "stale-admitted-parent" &&
                context.workload === "copilotz.owner.complete"
              ) {
                completionAdmitted.resolve();
                await completionRelease.promise;
              }
              const response = await handler(input);
              const decoded = JSON.parse(new TextDecoder().decode(response));
              reverseReplies.push({
                workload: context.workload,
                response: decoded,
              });
              if (
                mode === "ambiguous-claim" && !lostClaim &&
                context.workload === "copilotz.owner.command" && decoded.ok &&
                decoded.value?.result?.executionId
              ) {
                lostClaim = true;
                throw new Error("injected loss after durable claim reply");
              }
              return response;
            };
          },
          maxConcurrent: 2,
          maxPerConnection: 2,
          timeoutMs: 10_000,
        },
        admit: ({ credential }: { credential: { kind: string } }) => ({
          definition: {
            workerId: "worker",
            providerId: "fixture",
            workloads: [OWNER_ACTION_WORKLOAD],
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
      }, {
        async onReady(context: { fence: Fence }) {
          const fence = context.fence;
          await f.db.query(
            "INSERT INTO fixture_sessions VALUES($1,$2,$3,$4,$5)",
            [
              fence.connectionId,
              fence.identity.workerId,
              fence.identity.attemptId,
              fence.sessionGeneration,
              mode !== "readiness-denied",
            ],
          );
        },
        async onWorkAssigned(context: Assigned) {
          const { fence, streamId } = context.assignment;
          await f.replace({
            assignmentId: streamId,
            sessionId: fence.connectionId,
            workerId: fence.identity.workerId,
            dispatchAttemptId: `dispatch:${streamId}`,
          });
          await f.db.query(
            "INSERT INTO fixture_parent_bindings VALUES($1,$2,$3,$4,$5,TRUE)",
            [
              streamId,
              context.operationId,
              fence.connectionId,
              fence.identity.attemptId,
              fence.sessionGeneration,
            ],
          );
        },
      });
      const listener = transport === "websocket"
        ? await serve({ hypervisor: host })
        : undefined;
      const url = listener ? new URL("/workers", listener.url) : undefined;
      if (url) url.protocol = "ws:";
      const worker = createOwnerConnectedWorker({
        registry: f.registry,
        ownerId: "owner",
        namespace: "space",
        ownerReadyTimeoutMs: 10_000,
        worker: {
          id: "worker",
          transport: url
            ? {
              type: "websocket",
              config: { url, allowInsecureLoopback: true },
            }
            : local,
          capacity: 1,
          ...{ hostCalls: { maxConcurrent: 2, timeoutMs: 10_000 } },
          activate: () => identity,
          register: () => ({
            credential: { kind: "registration", capability: "fixture" },
            expiresAtMs: Date.now() + 60_000,
          }),
          reconnectDelay: false,
        },
        createCapabilities: ({ registry }) => ({
          resources: { fixture: registry.resources.fixture },
          adapters: registry.adapters,
        }),
      });
      try {
        if (mode === "readiness-denied") {
          await assert.rejects(within(worker.ready));
          assert.equal(worker.snapshot().ownerReady, false);
          assert.equal(f.state.executions, 0);
          assert.equal(
            (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
            0,
          );
          return;
        }
        if (mode === "committed") {
          await within(readinessReached.promise);
          assert.equal(worker.snapshot().ownerReady, false);
          assert.equal(f.state.executions, 0);
          f.state.gateKind = "execution.claim";
        } else await within(worker.ready);
        const dispatch = await host.dispatch({
          workload: OWNER_ACTION_WORKLOAD,
          target: { workerId: "worker" },
          metadata: { ignoredWorkerInput: "MUST_NOT_BE_ACTION_INPUT" },
          deadlineAtMs: Date.now() + 20_000,
        });
        let exposed = false;
        const output = new Response(dispatch.output).text().then((value) => {
          exposed = true;
          return value;
        });
        // Observe rejected output without allowing an unhandled rejection while
        // waiting on the terminal work frame.
        void output.catch(() => undefined);
        if (mode === "committed") {
          assert.equal(f.state.executions, 0);
          assert.equal(
            (await f.db.query("SELECT * FROM owner_receipts")).rows.length,
            0,
          );
          readinessRelease.resolve();
          await within(worker.ready);
          const claimGate = { ...f.gate };
          await within(claimGate.reached.promise);
          assert.equal(f.state.executions, 0);
          assert.equal(exposed, false);
          assert.equal(f.state.publications.length, 0);
          const terminalGate = { reached: deferred(), release: deferred() };
          f.gate.reached = terminalGate.reached;
          f.gate.release = terminalGate.release;
          f.state.gateKind = "execution.complete";
          claimGate.release.resolve();
          await within(terminalGate.reached.promise);
          assert.equal(exposed, false);
          assert.equal(f.state.executions, 1);
          assert.equal(
            f.state.publications.includes("fixture.work.completed"),
            false,
          );
          terminalGate.release.resolve();
          const result = JSON.parse(await within(output));
          assert.deepEqual(result, {
            status: "executed",
            receipt: { ...f.reference(), status: "completed" },
          });
          assert.equal(
            (await within<{ status: string }>(dispatch.completed)).status,
            "completed",
          );
          await within(f.observed.promise);
          assert.deepEqual(f.state.observations, [1]);
          assert.equal(f.state.persistenceOpens, 0);
          assert.equal(JSON.stringify(result).includes("world"), false);
          assert.equal(
            (await f.db.query(
              "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
            )).rows.length,
            1,
          );
        } else if (mode === "ctx-revoked") {
          await within(actionReached.promise);
          await f.set("ctx_granted", false);
          actionRelease.resolve();
          const result = JSON.parse(await within(output));
          assert.equal(result.receipt.status, "failed");
          assert.equal(deniedMutation, true);
          assert.equal(completionWithRevokedCtx, true);
          assert.deepEqual(
            (await f.db.query("SELECT id FROM nodes ORDER BY id")).rows,
            [{ id: "note" }],
          );
          assert.equal(
            (await within<{ status: string }>(dispatch.completed)).status,
            "completed",
          );
        } else if (mode === "stale-admitted-parent") {
          await within(completionAdmitted.promise);
          await f.db.query(
            "UPDATE fixture_parent_bindings SET session_generation=session_generation+1",
          );
          completionRelease.resolve();
          await within(Promise.allSettled([output, dispatch.completed]));
          assert.equal((await dispatch.completed).status, "failed");
          assert.equal(
            (await f.db.query(
              "SELECT id FROM events WHERE deduplication_id='run:action:terminal'",
            )).rows.length,
            0,
          );
          assert.equal(
            (await f.db.query(
              "SELECT key FROM owner_receipts WHERE kind='execution.complete'",
            )).rows.length,
            0,
          );
          assert.ok(
            reverseReplies.some((item) =>
              item.workload === "copilotz.owner.complete" &&
              (item.response as { code?: string }).code ===
                "ActionOwnershipLost"
            ),
          );
        } else {
          await within(Promise.allSettled([output, dispatch.completed]));
          assert.equal((await dispatch.completed).status, "failed");
          assert.equal(lostClaim, true);
          assert.equal(f.state.executions, 0);
          assert.equal(
            f.state.projections,
            1,
            "owner capture occurred but no worker hydration",
          );
          assert.equal(
            (await f.db.query(
              "SELECT key FROM owner_receipts WHERE kind='execution.claim'",
            )).rows.length,
            1,
          );
          const again = await host.dispatch({
            workload: OWNER_ACTION_WORKLOAD,
            target: { workerId: "worker" },
            deadlineAtMs: Date.now() + 10_000,
          });
          const secondOutput = new Response(again.output).text();
          await within(Promise.allSettled([secondOutput, again.completed]));
          assert.equal((await again.completed).status, "failed");
          assert.equal(f.state.executions, 0);
          assert.equal(
            (await f.db.query(
              "SELECT key FROM owner_receipts WHERE kind='execution.claim'",
            )).rows.length,
            1,
          );
        }
      } finally {
        readinessRelease.resolve();
        actionRelease.resolve();
        completionRelease.resolve();
        f.gate.release.resolve();
        await worker.close();
        await host.shutdown();
        await listener?.shutdown();
        await f.close();
      }
    });
  }
}
