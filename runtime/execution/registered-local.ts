/** Dormant, fresh-only owner-local Action driver. This owns one invocation,
 * never host capacity, durable authority, retries or receipt recovery. */
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
} from "../owner/boundary.ts";
import type { OwnerEffectPort } from "../owner/effects-client.ts";
import type { OwnerLocalActionProjection } from "../owner/execution.ts";
import {
  type OwnerLocalActionAssignmentBinding,
  parseOwnerPlacementBinding,
} from "../owner/placement-binding.ts";
import { assertJsonValue } from "../json.ts";
import { runRegisteredActionInvocation } from "./registered-action-invocation.ts";
import type {
  RegisteredActionInvocation,
  RegisteredContextCapabilities,
  RegisteredExecutionCompletion,
  RegisteredInvocationCalls,
} from "./registered-invocation.ts";

export type RegisteredLocalActionReference = OwnerLocalActionAssignmentBinding;
export type RegisteredLocalActionReceipt = Readonly<{
  reference: RegisteredLocalActionReference;
  status: "completed" | "failed" | "cancelled";
}>;
/** Private current settlement authorization, not input/receipt recovery. */
export type RegisteredLocalActionSettlementState = Readonly<{
  reference: RegisteredLocalActionReference;
  cancellationRequested: boolean;
}>;
export type RegisteredLocalActionCompletionOutcome =
  | Readonly<{
    status: "committed" | "duplicate";
    result: RegisteredLocalActionReceipt;
  }>
  /** The bound adapter must independently prove definitive noncommit. An
   * arbitrary exception, timeout or missing receipt cannot produce this fact. */
  | Readonly<{
    status: "not-committed";
    reference: RegisteredLocalActionReference;
  }>;
/** Permanently bound by the host to one exact private local principal/handle.
 * Raw accounting lives below child wait/timeout races. These private lifecycle
 * methods are never exposed to the invocation kernel or plugin capabilities. */
export type RegisteredLocalActionPort = Readonly<{
  start(options?: OwnerCommandExecuteOptions): Promise<
    Readonly<{
      status: "committed" | "duplicate";
      result: Readonly<{
        binding: RegisteredLocalActionReference;
        attempts: number;
      }>;
    }>
  >;
  project(
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerLocalActionProjection>;
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  effects?: OwnerEffectPort;
  invokeAction?: RegisteredInvocationCalls["invokeAction"];
  prepareAction?: RegisteredInvocationCalls["prepareAction"];
  readCollection?: RegisteredInvocationCalls["readCollection"];
  /** Synchronously stop new invocation registrations, retaining only narrowly
   * authorized already-admitted settlement and driver terminal/state calls. */
  sealInvocationCalls(): void;
  /** Resolve only once every actual underlying raw call has settled. Rejection
   * cannot establish quiescence. This also tracks terminal and state calls. */
  drainRawCalls(): Promise<void>;
  settlementState(
    options?: OwnerCommandExecuteOptions,
  ): Promise<RegisteredLocalActionSettlementState>;
  /** The host must independently retain known raw terminal outcomes. If the
   * private handle is revoked during this await, the driver refuses success
   * even after a committed reply; that refusal cannot erase the durable fact. */
  complete(
    completion: RegisteredExecutionCompletion,
    options?: OwnerCommandExecuteOptions,
  ): Promise<RegisteredLocalActionCompletionOutcome>;
}>;
export type RegisteredLocalActionResult = Readonly<{
  status: "executed";
  completion: RegisteredExecutionCompletion;
  receipt: RegisteredLocalActionReceipt;
}>;
export type RegisteredLocalActionOptions = Readonly<{
  registry: PluginRegistry;
  reference: RegisteredLocalActionReference;
  owner: RegisteredLocalActionPort;
  createCapabilities(
    input: Readonly<{
      registry: PluginRegistry;
      reference: RegisteredLocalActionReference;
      invocation: RegisteredActionInvocation;
      signal: AbortSignal;
    }>,
  ): RegisteredContextCapabilities | Promise<RegisteredContextCapabilities>;
  /** Exact host-private lifetime, including its separately current settlement
   * gate. A durable reservation/tuple alone must never satisfy this callback. */
  isCurrent(): boolean;
  /** Sticky stop/quarantine notification. It never releases host capacity. */
  onIndeterminate(error: unknown): void;
}>;

function failure(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code, { cause }), {
    name: "RegisteredLocalActionError",
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
    throw failure("registered_local_data_limit");
  }
  return structuredClone(value);
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const data = snapshot(value);
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    required.some((key) => !Object.hasOwn(data, key)) ||
    Object.keys(data).some((key) => ![...required, ...optional].includes(key))
  ) throw failure("registered_local_data_invalid");
  return data as Record<string, unknown>;
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) throw failure("registered_local_identity_invalid");
}
function reference(value: unknown): RegisteredLocalActionReference {
  const binding = parseOwnerPlacementBinding(value);
  if (binding.placement !== "owner-local" || binding.kind !== "action") {
    throw failure("registered_local_reference_invalid");
  }
  return binding;
}
function exactReference(
  value: unknown,
  expected: RegisteredLocalActionReference,
): RegisteredLocalActionReference {
  const actual = reference(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw failure("registered_local_reference_invalid");
  }
  return actual;
}
function invocation(
  value: unknown,
  expected: RegisteredLocalActionReference,
): RegisteredActionInvocation {
  const data = object(value, [
    "reference",
    "actionId",
    "input",
    "namespace",
    "databaseSchema",
    "ownerId",
    "invocation",
  ]);
  exactReference(data.reference, expected);
  for (const key of ["actionId", "namespace", "databaseSchema", "ownerId"]) {
    identifier(data[key]);
  }
  if (
    data.actionId !== expected.actionId ||
    data.namespace !== expected.namespace || data.ownerId !== expected.ownerId
  ) throw failure("registered_local_projection_invalid");
  const frame = object(data.invocation, [
    "actionRunId",
    "rootKey",
    "operationKey",
    "metadata",
    "identity",
  ], ["parentActionRunId"]);
  for (const key of ["actionRunId", "rootKey", "operationKey"]) {
    identifier(frame[key]);
  }
  if (
    frame.actionRunId !== expected.actionRunId ||
    frame.operationKey !== expected.actionRunId
  ) throw failure("registered_local_projection_invalid");
  if (Object.hasOwn(frame, "parentActionRunId")) {
    identifier(frame.parentActionRunId);
  }
  if (
    !frame.metadata || typeof frame.metadata !== "object" ||
    Array.isArray(frame.metadata)
  ) throw failure("registered_local_projection_invalid");
  const identity = object(frame.identity, [
    "causationId",
    "correlationId",
    "settlementScopeId",
  ], ["actionScopeId"]);
  for (const value of Object.values(identity)) identifier(value);
  if (identity.causationId !== expected.sourceEventId) {
    throw failure("registered_local_projection_invalid");
  }
  const { reference: _reference, ...result } = data;
  return result as RegisteredActionInvocation;
}
function unknownOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.indeterminate === true || value.outcome === "unknown" ||
    value.execution === "indeterminate" ||
    [
      "owner_commit_unknown",
      "persistence_indeterminate",
      "effect_indeterminate",
    ]
      .includes(String(value.code));
}

export function createRegisteredLocalActionExecution(
  options: RegisteredLocalActionOptions,
): Readonly<{
  run(): Promise<RegisteredLocalActionResult>;
  /** Trusted hint only after known committed scope cancellation. The current
   * settlement projection must still independently establish cancellation. */
  cancelCommitted(): void;
  revoke(reason?: unknown): void;
  /** Actual code/raw-call drain only. This does not certify a durable terminal,
   * known nonstart, release capacity, or clear an indeterminate outcome. */
  quiescent: Promise<void>;
}> {
  const expected = reference(options.reference);
  const registry = options.registry;
  const createCapabilities = options.createCapabilities;
  const isCurrent = options.isCurrent;
  const onIndeterminate = options.onIndeterminate;
  const owner = options.owner;
  // Capture every trusted method once; a retained mutable options object cannot
  // rebind this handle after its first suspension.
  const start = owner.start.bind(owner);
  const project = owner.project.bind(owner);
  const execute = owner.execute.bind(owner);
  const invokeAction = owner.invokeAction?.bind(owner);
  const prepareAction = owner.prepareAction?.bind(owner);
  const readCollection = owner.readCollection?.bind(owner);
  const settlementState = owner.settlementState.bind(owner);
  const complete = owner.complete.bind(owner);
  const seal = owner.sealInvocationCalls.bind(owner);
  const drain = owner.drainRawCalls.bind(owner);
  const effectPort = owner.effects;
  const effectExecute = effectPort?.execute.bind(effectPort);
  const effectSettle = effectPort?.settle.bind(effectPort);
  const effectProject = effectPort?.project.bind(effectPort);
  const command = new AbortController();
  const exposed = new AbortController();
  let cancelled = false;
  let revoked = false;
  let revokeReason: unknown;
  let uncertainty: unknown;
  let uncertain = false;
  let invocationOpen = false;
  let sealed = false;
  let sealFailure: unknown;
  let sealFailed = false;
  let pending: Promise<RegisteredLocalActionResult> | undefined;
  let cleanup: Promise<void> | undefined;
  let resolveQuiescent!: () => void;
  const quiescent = new Promise<void>((resolve) => {
    resolveQuiescent = resolve;
  });
  const indeterminate = (error: unknown): unknown => {
    if (!uncertain) {
      uncertain = true;
      uncertainty = Object.assign(
        failure("registered_local_indeterminate", error),
        { execution: "indeterminate" },
      );
      command.abort(uncertainty);
      exposed.abort(uncertainty);
      try {
        onIndeterminate(uncertainty);
      } catch {
        // Notification cannot replace the sticky original unknown outcome.
      }
    }
    return uncertainty;
  };
  const checkCurrent = () => {
    if (uncertain) throw uncertainty;
    if (!revoked) {
      let current = false;
      try {
        current = isCurrent() === true;
      } catch (error) {
        // A transient callback failure cannot be reclassified as a business
        // failure and revived by the next successful private-current check.
        revokeReason = failure("registered_local_authority_lost", error);
      }
      if (!current) {
        revoked = true;
        revokeReason ??= failure("registered_local_authority_lost");
        command.abort(revokeReason);
        exposed.abort(revokeReason);
      }
    }
    if (revoked) throw revokeReason;
  };
  const check = () => {
    checkCurrent();
    if (cancelled) throw failure("action_cancelled");
    if (!invocationOpen) throw failure("registered_local_context_closed");
  };
  const closeInvocation = () => {
    invocationOpen = false;
    exposed.abort();
    if (!sealed) {
      sealed = true;
      try {
        seal();
      } catch (error) {
        sealFailed = true;
        sealFailure = indeterminate(error);
      }
    }
    if (sealFailed) throw sealFailure;
  };
  const drainCalls = async () => {
    try {
      await drain();
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const finish = (): Promise<void> => {
    if (!cleanup) {
      cleanup = Promise.resolve().then(async () => {
        try {
          closeInvocation();
          await drainCalls();
          command.abort();
          resolveQuiescent();
        } catch (error) {
          throw indeterminate(error);
        }
      });
    }
    return cleanup;
  };
  const call = async <T>(
    work: () => Promise<T>,
    settlement = false,
  ): Promise<T> => {
    check();
    let result: T;
    try {
      result = await work();
    } catch (error) {
      if (unknownOutcome(error)) throw indeterminate(error);
      checkCurrent();
      throw error;
    }
    if (settlement) checkCurrent();
    else check();
    return result;
  };
  const commandCall = async (
    work: () => Promise<OwnerCommandOutcome>,
    settlement = false,
  ): Promise<OwnerCommandOutcome> => {
    const result = await call(work, settlement);
    if (settlement) checkCurrent();
    else check();
    try {
      const data = object(result, ["status", "result"]);
      if (data.status !== "committed" && data.status !== "duplicate") {
        throw failure("registered_local_command_outcome_invalid");
      }
      return data as OwnerCommandOutcome;
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const effects: OwnerEffectPort | undefined = effectPort
    ? {
      execute: (input, callOptions) =>
        commandCall(() => effectExecute!(input, callOptions)),
      settle: (input, callOptions) =>
        commandCall(() => effectSettle!(input, callOptions), true),
      project: (kind, input, callOptions) =>
        call(() => effectProject!(kind, input, callOptions)),
    }
    : undefined;
  const state = async (): Promise<boolean> => {
    checkCurrent();
    const result = await settlementState({});
    checkCurrent();
    try {
      const data = object(result, ["reference", "cancellationRequested"]);
      exactReference(data.reference, expected);
      if (typeof data.cancellationRequested !== "boolean") {
        throw failure("registered_local_settlement_invalid");
      }
      return data.cancellationRequested;
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const terminal = async (
    completion: RegisteredExecutionCompletion,
  ): Promise<RegisteredLocalActionReceipt | undefined> => {
    checkCurrent();
    let result: RegisteredLocalActionCompletionOutcome;
    try {
      // Separate narrow settlement calls never reuse the aborted command signal.
      result = await complete(snapshot(completion), {});
    } catch (error) {
      // Only the explicit trusted-port witness can establish noncommit.
      throw indeterminate(error);
    }
    checkCurrent();
    try {
      const data = object(result, ["status"], ["reference", "result"]);
      if (data.status === "not-committed") {
        object(data, ["status", "reference"]);
        exactReference(data.reference, expected);
        return undefined;
      }
      object(data, ["status", "result"]);
      if (data.status !== "committed" && data.status !== "duplicate") {
        throw failure("registered_local_completion_invalid");
      }
      const receipt = object(data.result, ["reference", "status"]);
      const ref = exactReference(receipt.reference, expected);
      if (receipt.status !== completion.status) {
        throw failure("registered_local_completion_conflict");
      }
      return { reference: ref, status: completion.status };
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const cancelledCompletion = (): RegisteredExecutionCompletion => ({
    status: "cancelled",
    code: "action_cancelled",
  });
  const run = async (): Promise<RegisteredLocalActionResult> => {
    try {
      checkCurrent();
      if (cancelled) throw failure("action_cancelled");
      let started: Awaited<ReturnType<typeof start>>;
      try {
        started = await start({ signal: command.signal });
      } catch (error) {
        // Conservatively quarantine every post-submission start failure.
        throw indeterminate(error);
      }
      checkCurrent();
      try {
        const data = object(started, ["status", "result"]);
        const result = object(data.result, ["binding", "attempts"]);
        exactReference(result.binding, expected);
        if (data.status !== "committed" || result.attempts !== 1) {
          throw failure("registered_local_fresh_start_required");
        }
      } catch (error) {
        throw indeterminate(error);
      }
      let completion: RegisteredExecutionCompletion;
      try {
        if (cancelled) completion = cancelledCompletion();
        else {
          const projected = await project({ signal: command.signal });
          checkCurrent();
          let projectedInvocation: RegisteredActionInvocation;
          try {
            projectedInvocation = invocation(projected, expected);
          } catch (error) {
            throw indeterminate(error);
          }
          if (cancelled) completion = cancelledCompletion();
          else {
            invocationOpen = true;
            check();
            completion = await runRegisteredActionInvocation({
              registry,
              invocation: projectedInvocation,
              lifetime: {
                check,
                isCancelled: () => cancelled,
                commandSignal: command.signal,
                exposedSignal: exposed.signal,
              },
              calls: {
                ...(readCollection
                  ? {
                    readCollection: (input, callOptions) =>
                      call(() => readCollection(snapshot(input), callOptions)),
                  }
                  : {}),
                ...(prepareAction
                  ? {
                    prepareAction: (input, callOptions) =>
                      call(() => prepareAction(input, callOptions)),
                  }
                  : {}),
                execute: (input, callOptions) =>
                  commandCall(() => execute(input, callOptions)),
                ...(invokeAction
                  ? {
                    invokeAction: (input, callOptions) =>
                      call(() => invokeAction(input, callOptions)),
                  }
                  : {}),
              },
              effects,
              createCapabilities: async () => {
                check();
                const capabilities = await createCapabilities({
                  registry,
                  reference: snapshot(expected),
                  invocation: snapshot(projectedInvocation),
                  signal: exposed.signal,
                });
                check();
                return capabilities;
              },
            });
            checkCurrent();
          }
        }
      } catch (error) {
        if (unknownOutcome(error)) throw indeterminate(error);
        checkCurrent();
        completion = cancelled
          ? cancelledCompletion()
          : { status: "failed", code: "action_failed" };
      } finally {
        closeInvocation();
      }
      if (
        completion.status === "failed" &&
        completion.code === "effect_indeterminate"
      ) {
        throw indeterminate(failure("effect_indeterminate"));
      }
      await drainCalls();
      checkCurrent();
      if (await state()) completion = cancelledCompletion();
      else if (cancelled || completion.status === "cancelled") {
        throw failure("registered_local_cancellation_unconfirmed");
      }
      checkCurrent();
      let receipt = await terminal(completion);
      checkCurrent();
      if (!receipt && completion.status !== "cancelled") {
        // One race repair only, after known noncommit and fresh current evidence.
        if (await state()) {
          checkCurrent();
          completion = cancelledCompletion();
          receipt = await terminal(completion);
          checkCurrent();
        }
      }
      if (!receipt) throw failure("registered_local_completion_not_committed");
      return { status: "executed", completion, receipt };
    } catch (error) {
      if (unknownOutcome(error)) throw indeterminate(error);
      throw error;
    } finally {
      await finish();
    }
  };
  return {
    run() {
      // Publish the first promise before any callback can reenter run().
      pending ??= Promise.resolve().then(run);
      return pending;
    },
    cancelCommitted() {
      cancelled = true;
      command.abort();
      exposed.abort();
      try {
        closeInvocation();
      } catch {
        // closeInvocation already reported the sticky quarantine condition.
      }
    },
    revoke(reason: unknown = failure("registered_local_authority_lost")) {
      if (!revoked) {
        revoked = true;
        revokeReason = reason;
      }
      command.abort(revokeReason);
      exposed.abort(revokeReason);
      try {
        closeInvocation();
      } catch {
        // Keep revocation synchronous; no failed seal certifies quiescence.
      }
      // A never-started revoked object has no kernel/factory to await.
      if (!pending) void finish().catch(() => {});
    },
    quiescent,
  };
}
