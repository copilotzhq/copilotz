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

import { createExecutionHeartbeat } from "./execution-heartbeat.ts";
import type { RegisteredExecutionRecovery } from "./recovery.ts";

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
export type { RegisteredExecutionCompletion } from "./registered-invocation.ts";
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
  recovery?: RegisteredExecutionRecovery;
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
  /** Ordinary parent-bound child invocation. The owner independently derives
   * durable parent identity and authority; no root-ingress fallback is valid. */
  prepareAction?(
    input: Readonly<
      {
        reference: RegisteredExecutionReference;
        actionAlias: string;
        preparation: string;
        recordId: string;
        mode: string;
        operationKey: string;
      }
    >,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  invokeAction?(
    input: Readonly<{
      reference: RegisteredExecutionReference;
      actionAlias: string;
      input: OwnerJson;
      operationKey: string;
    }>,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
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

import { assertJsonValue } from "../json.ts";
import { runRegisteredActionInvocation } from "./registered-action-invocation.ts";
import type { RegisteredExecutionCompletion } from "./registered-invocation.ts";

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
/** Ordinary function lifetime only; open response-body renewal is unsupported. */
function executionHeartbeat(input: {
  port: RegisteredOwnerExecutionPort;
  reference: RegisteredExecutionReference;
  lease: RegisteredExecutionLease;
  started: number;
  fail(error: unknown): void;
}) {
  return createExecutionHeartbeat({
    ...input,
    renew: (ref, options) => input.port.renew(snapshot(ref), options),
    validate(result, expected) {
      const actual = reference({
        executionId: result.executionId,
        deliveryId: result.deliveryId,
        dispatchAttemptId: result.dispatchAttemptId,
      });
      if (
        Object.keys(actual).some((key) =>
          actual[key as keyof typeof actual] !==
            expected[key as keyof typeof actual]
        )
      ) {
        throw failure("registered_worker_reference_invalid");
      }
      snapshot(result.lease);
    },
  });
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
      const invokeAction = projection.invocation.operationKey ===
            projection.invocation.actionRunId &&
          projection.invocation.actionRunId === ref.executionId
        ? port.invokeAction?.bind(port)
        : undefined;
      const prepareAction = projection.invocation.operationKey ===
            projection.invocation.actionRunId &&
          projection.invocation.actionRunId === ref.executionId
        ? port.prepareAction?.bind(port)
        : undefined;
      const execute = port.execute.bind(port);
      let completion: RegisteredExecutionCompletion;
      try {
        completion = await runRegisteredActionInvocation({
          registry,
          invocation: {
            actionId: projection.actionId,
            ...(projection.recovery === undefined
              ? {}
              : { recovery: projection.recovery }),
            input: projection.input,
            namespace: projection.namespace,
            databaseSchema: projection.databaseSchema,
            ownerId: projection.ownerId,
            invocation: projection.invocation,
          },
          lifetime: {
            check,
            isCancelled: () => cancelled,
            commandSignal: control.signal,
            exposedSignal: exposed.signal,
          },
          calls: {
            execute,
            ...(prepareAction
              ? {
                prepareAction: (input, callOptions) =>
                  prepareAction(
                    { reference: snapshot(ref), ...input },
                    callOptions,
                  ),
              }
              : {}),
            ...(invokeAction
              ? {
                invokeAction: (input, callOptions) =>
                  invokeAction({
                    reference: snapshot(ref),
                    ...input,
                  }, callOptions),
              }
              : {}),
          },
          effects: port.effects,
          createCapabilities: () =>
            createCapabilities({
              registry,
              reference: snapshot(ref),
              projection: snapshot(projection),
              signal: exposed.signal,
            }),
        });
      } finally {
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
