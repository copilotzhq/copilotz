/** Internal ordinary-JSON Action execution over named, host-bound owner ports.
 * No public worker factory or complete Action lifecycle is implied. */
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  ActionInvocationMetadata,
  RuntimeContextNamespaces,
  RuntimeIdentity,
} from "../actions/types.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
} from "../owner/boundary.ts";
import type { OwnerEffectPort } from "../owner/effects-client.ts";
import { createOwnerEffectClient } from "../owner/effects-client.ts";
import { createActionEffectCapability } from "../actions/effects.ts";

/** Host-derived live assignment identity. These hints never grant authority. */
export type RegisteredWorkerAssignment = Readonly<{
  assignmentId: string;
  sessionId: string;
}>;
export type RegisteredExecutionReference = Readonly<{
  executionId: string;
  deliveryId: string;
  dispatchAttemptId: string;
}>;
export type RegisteredExecutionCompletion =
  | Readonly<{ status: "completed"; output: OwnerJson }>
  | Readonly<{ status: "failed" | "cancelled"; code: string }>;
export type RegisteredExecutionReceipt =
  & RegisteredExecutionReference
  & Readonly<{
    status: "completed" | "failed" | "cancelled";
  }>;
/** Safe relative timing, discounted by monotonic request latency at the worker.
 * It is scheduling guidance, never a lease grant or a receipt replay permit.
 * A budget too short to renew (including one millisecond) refuses execution. */
export type RegisteredExecutionLease = Readonly<{
  remainingMs: number;
  renewAfterMs: number;
}>;
export type RegisteredExecutionRenewal =
  & RegisteredExecutionReference
  & Readonly<{
    lease: RegisteredExecutionLease;
  }>;
/** Authorized ordinary data, read only after a known durable claim. */
export type RegisteredExecutionProjection = Readonly<{
  actionId: string;
  lease: RegisteredExecutionLease;
  input: OwnerJson;
  namespace: string;
  databaseSchema: string;
  ownerId: string;
  workerId: string;
  invocation: Readonly<{
    actionRunId: string;
    rootKey: string;
    operationKey: string;
    parentActionRunId?: string;
    metadata: ActionInvocationMetadata;
    identity?: RuntimeIdentity;
  }>;
}>;
/** Trusted adapters implement these names using data, never shipped closures.
 * Claim/completion receipts contain references only; project rechecks the exact
 * current assignment, session, epoch and live lease before exposing input. */
export type RegisteredOwnerExecutionPort = Readonly<{
  /** Separately admitted effect routes, bound to this live assignment. Missing
   * capability refuses ctx.effect; never substitutes worker-local receipts. */
  effects?: OwnerEffectPort;
  claim(
    assignment: RegisteredWorkerAssignment,
    options: OwnerCommandExecuteOptions,
  ): Promise<
    Readonly<{
      status: "committed" | "duplicate";
      result: RegisteredExecutionReference;
    }>
  >;
  project(
    reference: RegisteredExecutionReference,
    options: OwnerCommandExecuteOptions,
  ): Promise<RegisteredExecutionProjection>;
  renew(
    reference: RegisteredExecutionReference,
    options: OwnerCommandExecuteOptions,
  ): Promise<
    Readonly<{
      status: "committed" | "duplicate";
      result: RegisteredExecutionRenewal;
    }>
  >;
  complete(
    reference: RegisteredExecutionReference,
    completion: RegisteredExecutionCompletion,
    options: OwnerCommandExecuteOptions,
  ): Promise<
    Readonly<{
      status: "committed" | "duplicate";
      result: RegisteredExecutionReceipt;
    }>
  >;
  /** Separately authenticated safe receipt recovery; never input hydration. */
  readCompletion(
    reference: RegisteredExecutionReference,
    options: OwnerCommandExecuteOptions,
  ): Promise<RegisteredExecutionReceipt | undefined>;
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
}>;
export type RegisteredWorkerCapabilities = Readonly<{
  resources: RuntimeContextNamespaces;
  adapters: RuntimeContextNamespaces;
}>;
export type RegisteredWorkerResult =
  | Readonly<
    {
      status: "executed";
      completion: RegisteredExecutionCompletion;
      receipt: RegisteredExecutionReceipt;
    }
  >
  | Readonly<{ status: "replayed"; receipt: RegisteredExecutionReceipt }>;
export type RegisteredWorkerOptions = Readonly<{
  registry: PluginRegistry;
  owner: RegisteredOwnerExecutionPort;
  /** Trusted placement selection, invoked only after claim and projection. */
  createCapabilities(
    input: Readonly<{
      registry: PluginRegistry;
      reference: RegisteredExecutionReference;
      projection: RegisteredExecutionProjection;
      signal: AbortSignal;
    }>,
  ): RegisteredWorkerCapabilities | Promise<RegisteredWorkerCapabilities>;
  /** Lifetime bound, including completed entries and unresolved tombstones.
   * A full worker refuses new assignments; this is not reusable concurrency.
   * Host assignment/session recovery is required before replacing the worker. */
  maxAssignments?: number;
}>;

import { createActionInvocationContext } from "../actions/execution-context.ts";
import { actionTransactionIdentity } from "../actions/transaction-identity.ts";
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { isActionDeferral } from "../actions/deferral.ts";
import type {
  ActionContext,
  ActionReconcileResult,
  ActionTransactionOptions,
  RuntimeContext,
} from "../actions/types.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { assertJsonValue } from "../json.ts";
import { createOwnerTransactionPlanner } from "../owner/transaction.ts";

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), {
    name: "RegisteredWorkerError",
    code,
  });
}
function snapshot<T>(value: T): T {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) {
    throw failure("registered_worker_data_limit");
  }
  return structuredClone(value);
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw failure("registered_worker_identity_invalid");
  }
}
function reference(
  value: RegisteredExecutionReference,
): RegisteredExecutionReference {
  const copied = snapshot(value);
  for (
    const key of ["executionId", "deliveryId", "dispatchAttemptId"] as const
  ) identifier(copied[key]);
  if (Object.keys(copied).length !== 3) {
    throw failure("registered_worker_reference_invalid");
  }
  return copied;
}
function receipt(
  value: RegisteredExecutionReceipt,
  expected: RegisteredExecutionReference,
): RegisteredExecutionReceipt {
  const copied = snapshot(value);
  if (
    !["completed", "failed", "cancelled"].includes(copied.status) ||
    Object.keys(copied).length !== 4
  ) {
    throw failure("registered_worker_receipt_invalid");
  }
  for (
    const key of ["executionId", "deliveryId", "dispatchAttemptId"] as const
  ) {
    if (copied[key] !== expected[key]) {
      throw failure(
        "registered_worker_receipt_invalid",
      );
    }
  }
  return copied;
}
function unknownOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    indeterminate?: unknown;
    outcome?: unknown;
    execution?: unknown;
  };
  return value.indeterminate === true || value.outcome === "unknown" ||
    value.execution === "indeterminate" ||
    ["owner_commit_unknown", "persistence_indeterminate"].includes(
      String(value.code),
    );
}
function sameIdentity(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): string => {
    if (value === undefined) return "";
    const copied = snapshot(value) as Record<string, unknown>;
    return JSON.stringify(
      Object.keys(copied).sort().map((key) => [key, copied[key]]),
    );
  };
  return normalize(left) === normalize(right);
}

/** Ordinary function lifetime only; open response-body renewal is unsupported.
 * One serial heartbeat loop. Stop never starts another call and drains the
 * current call before settlement. A timed-out call stays ambiguous even if its
 * eventual reply succeeds; no late result can reopen the capability scope. */
function executionHeartbeat(input: {
  port: RegisteredOwnerExecutionPort;
  reference: RegisteredExecutionReference;
  lease: RegisteredExecutionLease;
  started: number;
  fail(error: unknown): void;
}) {
  let stopped = false;
  let wake: (() => void) | undefined;
  let deadline = 0;
  let next = 0;
  const lost = () =>
    Object.assign(failure("registered_worker_renewal_unknown"), {
      indeterminate: true,
    });
  const update = (lease: RegisteredExecutionLease, started: number) => {
    if (
      !lease || Object.keys(lease).length !== 2 ||
      !Number.isSafeInteger(lease.remainingMs) || lease.remainingMs <= 0 ||
      !Number.isSafeInteger(lease.renewAfterMs) || lease.renewAfterMs <= 0 ||
      lease.renewAfterMs >= lease.remainingMs
    ) {
      throw failure("registered_worker_lease_invalid");
    }
    deadline = started + lease.remainingMs;
    next = Math.min(started + lease.renewAfterMs, deadline);
    if (deadline <= performance.now()) throw lost();
  };
  update(input.lease, input.started);
  const loop = (async () => {
    try {
      while (!stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(
            resolve,
            Math.max(0, Math.min(2_147_483_647, next - performance.now())),
          );
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
        if (stopped) return;
        const started = performance.now();
        const budget = deadline - started;
        if (budget <= 0) throw lost();
        const control = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let timeoutFailure: ReturnType<typeof lost> | undefined;
        try {
          const result = await Promise.race([
            input.port.renew(snapshot(input.reference), {
              signal: control.signal,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                // Latch uncertainty before abort listeners can settle the call.
                timeoutFailure = lost();
                reject(timeoutFailure);
                control.abort(timeoutFailure);
              }, Math.min(2_147_483_647, budget));
            }),
          ]);
          if (timeoutFailure) throw timeoutFailure;
          // Duplicate receipts carry old timing and cannot extend a local budget.
          if (result.status !== "committed") throw lost();
          const actual = reference({
            executionId: result.result.executionId,
            deliveryId: result.result.deliveryId,
            dispatchAttemptId: result.result.dispatchAttemptId,
          });
          if (
            Object.keys(actual).some((key) =>
              actual[key as keyof typeof actual] !==
                input.reference[key as keyof typeof actual]
            )
          ) {
            throw failure("registered_worker_reference_invalid");
          }
          if (performance.now() >= deadline) throw lost();
          update(snapshot(result.result.lease), started);
        } catch (error) {
          throw timeoutFailure ?? error;
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (error) {
      stopped = true;
      input.fail(error);
    }
  })();
  return {
    check() {
      if (!stopped && performance.now() >= deadline) throw lost();
    },
    requestStop() {
      stopped = true;
      wake?.();
    },
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}

/** One bounded worker lifetime. Entries, including uncertain outcomes, are never
 * evicted. Replacing this instance requires host assignment/session recovery;
 * it does not promise exactly-once business execution across process restarts. */
export function createRegisteredActionWorker(
  options: RegisteredWorkerOptions,
): Readonly<{
  execute(
    assignment: RegisteredWorkerAssignment,
    options?: OwnerCommandExecuteOptions,
  ): Promise<RegisteredWorkerResult>;
}> {
  const registry = options.registry;
  const port = options.owner;
  const createCapabilities = options.createCapabilities;
  const limit = options.maxAssignments ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("maxAssignments must be positive.");
  }
  type Assignment = {
    pending?: Promise<RegisteredWorkerResult>;
    failed?: Promise<RegisteredWorkerResult>;
    completed?: RegisteredExecutionReceipt;
  };
  const assignments = new Map<string, Assignment>();

  async function run(
    hint: RegisteredWorkerAssignment,
    signal?: AbortSignal,
  ): Promise<RegisteredWorkerResult> {
    let cancelled = signal?.aborted ?? false;
    const control = new AbortController();
    const exposed = new AbortController();
    let ownerOpen = true;
    let renewalFailed = false;
    let renewalFailure: unknown;
    let heartbeat: ReturnType<typeof executionHeartbeat> | undefined;
    const cancel = () => {
      cancelled = true;
      heartbeat?.requestStop();
      // Never expose the private signal used for command cancellation to Action code.
      control.abort();
      exposed.abort();
    };
    if (cancelled) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const check = () => {
      if (cancelled) throw failure("action_cancelled");
      if (!ownerOpen) throw failure("registered_worker_context_closed");
      if (renewalFailed) throw renewalFailure;
      heartbeat?.check();
    };
    try {
      check();
      const claimed = await port.claim(snapshot(hint), {
        signal: control.signal,
      });
      if (claimed.status !== "committed" && claimed.status !== "duplicate") {
        throw failure("registered_worker_claim_invalid");
      }
      const ref = reference(claimed.result);
      if (claimed.status === "duplicate") {
        const recovered = await port.readCompletion(snapshot(ref), {
          signal: control.signal,
        });
        if (!recovered) throw failure("registered_worker_replay_refused");
        return { status: "replayed", receipt: receipt(recovered, ref) };
      }
      check();
      const projectionStarted = performance.now();
      const projection = snapshot(
        await port.project(snapshot(ref), { signal: control.signal }),
      );
      for (
        const value of [
          projection.actionId,
          projection.namespace,
          projection.databaseSchema,
          projection.ownerId,
          projection.workerId,
          projection.invocation?.actionRunId,
          projection.invocation?.rootKey,
          projection.invocation?.operationKey,
        ]
      ) identifier(value);
      check();
      heartbeat = executionHeartbeat({
        port,
        reference: ref,
        lease: projection.lease,
        started: projectionStarted,
        fail(error) {
          renewalFailed = true;
          renewalFailure = error;
          control.abort(error);
          exposed.abort();
        },
      });
      let capabilityFailure = false;
      let registrationOpen = true;
      const pending: Promise<unknown>[] = [];
      let pendingFailure: unknown;
      let hasPendingFailure = false;
      let effectIndeterminate = false;
      const unsupported = (): never => {
        capabilityFailure = true;
        throw failure("registered_worker_capability_unsupported");
      };
      const unavailable = () => new Proxy({}, { get: unsupported });
      const track = <T>(start: () => Promise<T>): Promise<T> => {
        check();
        if (!registrationOpen) {
          throw failure("registered_worker_context_closed");
        }
        if (pending.length >= 100) return unsupported();
        let promise: Promise<T>;
        try {
          promise = start();
        } catch (error) {
          promise = Promise.reject(error);
        }
        pending.push(promise.catch((error) => {
          if (
            error && typeof error === "object" && "code" in error &&
            error.code === "effect_indeterminate"
          ) {
            effectIndeterminate = true;
          }
          if (!hasPendingFailure || unknownOutcome(error)) {
            hasPendingFailure = true;
            pendingFailure = error;
          }
        }));
        return promise;
      };
      const planner = createOwnerTransactionPlanner({
        collections: registry.collections,
        identity: {
          ownerId: projection.ownerId,
          workerId: projection.workerId,
          invocationId: projection.invocation.actionRunId,
        },
        execute(command, executeOptions) {
          check();
          if (capabilityFailure) return unsupported();
          return port.execute(command, executeOptions);
        },
      });
      const transaction = <T>(
        callback: (context: unknown) => T | Promise<T>,
        transactionOptions: ActionTransactionOptions = {},
      ): Promise<T> => {
        check();
        if (!registrationOpen) {
          throw failure("registered_worker_context_closed");
        }
        if (pending.length >= 100) return unsupported();
        if (
          !sameIdentity(
            transactionOptions.identity,
            actionTransactionIdentity(
              projection.invocation.identity,
              undefined,
            ),
          )
        ) return unsupported();
        return track(() =>
          planner({
            operationKey: transactionOptions.operationKey ?? "",
            signal: transactionOptions.signal
              ? AbortSignal.any([control.signal, transactionOptions.signal])
              : control.signal,
            execute: (context) =>
              callback({
                ...context,
                relations: unavailable(),
                vectors: unavailable(),
              }),
          }).then(({ value }) => value)
        );
      };
      let completion: RegisteredExecutionCompletion;
      try {
        check();
        const actions = Object.values(registry.actions).filter((action) =>
          action.id === projection.actionId
        );
        if (actions.length !== 1) {
          throw failure("registered_worker_action_unavailable");
        }
        const action = actions[0];
        if (
          action.content || action.resolve ||
          actionSchemaHasSecrets(action.inputSchema) ||
          actionSchemaHasSecrets(action.outputSchema)
        ) unsupported();
        if (action.inputSchema) {
          validateAgainstJsonSchema(
            action.inputSchema,
            projection.input,
            "Action input",
          );
        }
        const capabilities = await createCapabilities({
          registry,
          reference: snapshot(ref),
          projection: snapshot(projection),
          signal: exposed.signal,
        });
        check();
        const nested = Object.assign(unsupported, { prepare: unsupported });
        const absentEffect = (): never => {
          capabilityFailure = true;
          throw failure("action_effect_unavailable");
        };
        const effect = port.effects
          ? createActionEffectCapability({
            client: createOwnerEffectClient({
              ownerId: projection.ownerId,
              namespace: projection.namespace,
              actionRunId: projection.invocation.actionRunId,
              port: port.effects,
            }),
            signal: control.signal,
            check,
            track,
            context: () => context,
            reconcile: action.reconcile as
              | ((
                step: string,
                context: ActionContext,
              ) =>
                | ActionReconcileResult
                | Promise<ActionReconcileResult>)
              | undefined,
          })
          : {
            begin: absentEffect,
            inspect: absentEffect,
            confirm: absentEffect,
            notStarted: absentEffect,
          };
        const context = createActionInvocationContext({
          effect,
          host: {
            namespace: projection.namespace,
            databaseSchema: projection.databaseSchema,
            resources: capabilities.resources,
            adapters: capabilities.adapters,
            collections: new Proxy({}, { get: () => unavailable() }),
            vectors: unavailable(),
            content: Object.fromEntries(
              [
                "authorize",
                "prepare",
                "materialize",
                "publish",
                "get",
                "getMany",
                "resolve",
                "resolveMany",
                "open",
              ].map((name) => [name, unsupported]),
            ),
            streams: { open: unsupported, follow: unsupported },
            signal: exposed.signal,
            now: () => new Date(),
            transaction,
            readSnapshot: unsupported,
            signalDeferredWait: unsupported,
          } as unknown as RuntimeContext,
          frame: {
            ...snapshot(projection.invocation),
            actionId: projection.actionId,
            signal: exposed.signal,
            nextActionIndex: unsupported,
          },
          actions: new Proxy({}, { get: () => nested }),
          progress: unsupported,
          registerDeferredWait: unsupported,
        });
        let output: unknown;
        try {
          output = await (action.execute as (
            input: unknown,
            context: ActionContext,
          ) => unknown)(snapshot(projection.input), context);
        } finally {
          registrationOpen = false;
          await Promise.all(pending);
        }
        if (hasPendingFailure) throw pendingFailure;
        check();
        if (
          capabilityFailure || output instanceof ReadableStream ||
          isActionDeferral(output)
        ) unsupported();
        const data = snapshot(
          output === undefined ? null : output,
        ) as OwnerJson;
        if (action.outputSchema) {
          validateAgainstJsonSchema(action.outputSchema, data, "Action output");
        }
        completion = { status: "completed", output: data };
      } catch (error) {
        if (
          unknownOutcome(error) ||
          (hasPendingFailure && unknownOutcome(pendingFailure))
        ) {
          throw hasPendingFailure && unknownOutcome(pendingFailure)
            ? pendingFailure
            : error;
        }
        completion = cancelled
          ? { status: "cancelled", code: "action_cancelled" }
          : {
            status: "failed",
            code: capabilityFailure
              ? "action_capability_unsupported"
              : effectIndeterminate
              ? "effect_indeterminate"
              : "action_failed",
          };
      } finally {
        registrationOpen = false;
        ownerOpen = false;
        exposed.abort();
        await heartbeat.stop();
      }
      if (renewalFailed) {
        if (unknownOutcome(renewalFailure)) throw renewalFailure;
        completion = cancelled
          ? { status: "cancelled", code: "action_cancelled" }
          : { status: "failed", code: "action_failed" };
      }
      // A cancelled execution still attempts one safe terminal command. Current
      // owner authorization decides whether this assignment can settle anymore.
      const ack = await port.complete(
        snapshot(ref),
        snapshot(completion),
        cancelled || renewalFailed ? {} : { signal: control.signal },
      );
      if (ack.status !== "committed" && ack.status !== "duplicate") {
        throw failure("registered_worker_completion_invalid");
      }
      const completed = receipt(ack.result, ref);
      if (completed.status !== completion.status) {
        throw failure("registered_worker_completion_conflict");
      }
      return { status: "executed", completion, receipt: completed };
    } finally {
      ownerOpen = false;
      exposed.abort();
      await heartbeat?.stop();
      signal?.removeEventListener("abort", cancel);
    }
  }
  return {
    execute(assignment, executeOptions = {}) {
      const hint = snapshot(assignment);
      identifier(hint.assignmentId);
      identifier(hint.sessionId);
      if (Object.keys(hint).length !== 2) {
        return Promise.reject(failure("registered_worker_assignment_invalid"));
      }
      const key = JSON.stringify([hint.sessionId, hint.assignmentId]);
      const existing = assignments.get(key);
      if (existing?.pending) return existing.pending;
      if (existing?.failed) return existing.failed;
      if (existing?.completed) {
        const completed = existing.completed;
        const ref = reference({
          executionId: completed.executionId,
          deliveryId: completed.deliveryId,
          dispatchAttemptId: completed.dispatchAttemptId,
        });
        const recovery = (async (): Promise<RegisteredWorkerResult> => {
          const recovered = await port.readCompletion(
            snapshot(ref),
            executeOptions,
          );
          if (!recovered) throw failure("registered_worker_replay_refused");
          return { status: "replayed", receipt: receipt(recovered, ref) };
        })();
        existing.pending = recovery;
        void recovery.then(
          () => {
            existing.pending = undefined;
          },
          () => {
            existing.pending = undefined;
          },
        );
        return recovery;
      }
      if (assignments.size >= limit) {
        return Promise.reject(failure("registered_worker_capacity"));
      }
      const promise = run(hint, executeOptions.signal);
      const entry: Assignment = { pending: promise };
      assignments.set(key, entry);
      // Keep unresolved failures latched. Completed assignments retain only safe
      // references; another call reauthenticates receipt access, never cached T.
      void promise.then((result) => {
        entry.completed = snapshot(result.receipt);
        entry.pending = undefined;
      }, () => {
        entry.failed = promise;
        entry.pending = undefined;
      });
      return promise;
    },
  };
}
