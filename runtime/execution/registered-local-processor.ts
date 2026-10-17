/** One owner-local Processor attempt. The host owns generations, retry wakes,
 * durable authority and capacity; neither a receipt nor quiescence grants them. */
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
} from "../owner/boundary.ts";
import {
  type OwnerLocalProcessorAssignmentBinding,
  parseOwnerPlacementBinding,
} from "../owner/placement-binding.ts";
import type {
  OwnerLocalProcessorAttemptReceipt,
  OwnerLocalProcessorProjection,
  OwnerLocalProcessorSettlementState,
  OwnerLocalProcessorStartReceipt,
} from "../owner/processor.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  RegisteredContextCapabilities,
  RegisteredProcessorCompletion,
  RegisteredProcessorInvocation,
} from "./registered-invocation.ts";
import { runRegisteredProcessorInvocation } from "./registered-processor-invocation.ts";

export type RegisteredLocalProcessorCompletionOutcome =
  | Readonly<{
    status: "committed" | "duplicate";
    result: OwnerLocalProcessorAttemptReceipt;
  }>
  | Readonly<{
    /** Trusted bound-port proof of definitive noncommit, never an exception or
     * missing reply. It ends this run without retry permission. */
    status: "not-committed";
    reference: OwnerLocalProcessorAssignmentBinding;
  }>;
/** Permanently bound to a private current attempt. Accounting covers actual
 * underlying calls, below cancellation/timeouts; a rejected drain is not proof
 * that those calls stopped. No heartbeat or receipt-recovery operation exists. */
export type RegisteredLocalProcessorPort = Readonly<{
  start(options?: OwnerCommandExecuteOptions): Promise<
    Readonly<{
      status: "committed" | "duplicate";
      result: OwnerLocalProcessorStartReceipt;
    }>
  >;
  project(
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerLocalProcessorProjection>;
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  invokeAction?(
    input: Readonly<
      { actionAlias: string; input: OwnerJson; operationKey: string }
    >,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  sealInvocationCalls(): void;
  drainRawCalls(): Promise<void>;
  settlementState(
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerLocalProcessorSettlementState>;
  complete(
    completion: RegisteredProcessorCompletion,
    options?: OwnerCommandExecuteOptions,
  ): Promise<RegisteredLocalProcessorCompletionOutcome>;
}>;
export type RegisteredLocalProcessorResult = Readonly<{
  status: "executed";
  completion: RegisteredProcessorCompletion;
  receipt: OwnerLocalProcessorAttemptReceipt;
}>;
export type RegisteredLocalProcessorOptions = Readonly<{
  registry: PluginRegistry;
  reference: OwnerLocalProcessorAssignmentBinding;
  attemptOrdinal: number;
  owner: RegisteredLocalProcessorPort;
  createCapabilities(
    input: Readonly<{
      registry: PluginRegistry;
      reference: OwnerLocalProcessorAssignmentBinding;
      invocation: RegisteredProcessorInvocation;
      signal: AbortSignal;
    }>,
  ): RegisteredContextCapabilities | Promise<RegisteredContextCapabilities>;
  isCurrent(): boolean;
  onIndeterminate(error: unknown): void;
}>;

function failure(code: string, cause?: unknown) {
  return Object.assign(new Error(code, { cause }), {
    name: "RegisteredLocalProcessorError",
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
    throw failure("local_processor_data_limit");
  }
  return structuredClone(value);
}
function object(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const data = snapshot(value);
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    fields.some((key) => !Object.hasOwn(data, key)) ||
    Object.keys(data).some((key) =>
      !fields.includes(key) && !optional.includes(key)
    )
  ) {
    throw failure("local_processor_data_invalid");
  }
  return data as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) {
    throw failure("local_processor_identity_invalid");
  }
}
function timestamp(value: unknown): asserts value is string {
  text(value);
  // Validate the supported SQL/ISO envelope, but keep every fractional digit
  // in the returned receipt. Scheduling comparisons belong to the owner SQL.
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/
      .exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) {
    throw failure("local_processor_timestamp_invalid");
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    parts;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] ||
    Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59
  ) {
    throw failure("local_processor_timestamp_invalid");
  }
}
function reference(value: unknown): OwnerLocalProcessorAssignmentBinding {
  const result = parseOwnerPlacementBinding(value);
  if (result.placement !== "owner-local" || result.kind !== "processor") {
    throw failure("local_processor_reference_invalid");
  }
  if (result.consumerId !== `processor:${result.processorId}`) {
    throw failure("local_processor_reference_invalid");
  }
  return result;
}
function exact(value: unknown, expected: OwnerLocalProcessorAssignmentBinding) {
  const actual = reference(value);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw failure("local_processor_reference_invalid");
  }
  return actual;
}
/** Internal shared decoder for the driver and actual bound owner port. */
export function parseLocalProcessorProjection(
  value: unknown,
  expected: OwnerLocalProcessorAssignmentBinding,
  ordinal: number,
): RegisteredProcessorInvocation {
  const data = object(value, [
    "reference",
    "processorId",
    "ownerId",
    "namespace",
    "databaseSchema",
    "deliveryId",
    "event",
    "attempts",
    "maxAttempts",
    "operationKey",
    "identity",
  ]);
  exact(data.reference, expected);
  for (
    const key of [
      "processorId",
      "ownerId",
      "namespace",
      "databaseSchema",
      "deliveryId",
      "operationKey",
    ]
  ) text(data[key]);
  if (
    data.processorId !== expected.processorId ||
    data.ownerId !== expected.ownerId ||
    data.namespace !== expected.namespace ||
    data.deliveryId !== expected.deliveryId ||
    data.operationKey !== `delivery:${expected.deliveryId}` ||
    data.attempts !== ordinal ||
    !Number.isSafeInteger(data.maxAttempts) ||
    Number(data.maxAttempts) < ordinal
  ) {
    throw failure("local_processor_projection_invalid");
  }
  const event = object(data.event, [
    "durable",
    "id",
    "ownerId",
    "position",
    "seq",
    "schemaVersion",
    "type",
    "namespace",
    "correlationId",
    "createdAt",
    "metadata",
    "payload",
    "data",
  ], ["subject", "delta", "causationId", "deduplicationId"]);
  if (
    !event || typeof event !== "object" || Array.isArray(event) ||
    event.id !== expected.sourceEventId ||
    event.namespace !== expected.namespace ||
    event.ownerId !== expected.ownerId || event.durable !== true
  ) {
    throw failure("local_processor_projection_invalid");
  }
  for (const key of ["type", "correlationId", "position", "seq"]) {
    text(event[key]);
  }
  if (
    !/^[1-9][0-9]*$/.test(event.position as string) ||
    !/^[1-9][0-9]*$/.test(event.seq as string) ||
    !Number.isSafeInteger(event.schemaVersion) ||
    Number(event.schemaVersion) < 1 ||
    !event.metadata || typeof event.metadata !== "object" ||
    Array.isArray(event.metadata)
  ) {
    throw failure("local_processor_projection_invalid");
  }
  timestamp(event.createdAt);
  for (const key of ["causationId", "deduplicationId"]) {
    if (Object.hasOwn(event, key)) text(event[key]);
  }
  if (Object.hasOwn(event, "subject")) {
    const subject = object(event.subject, ["type", "id"]);
    text(subject.type);
    text(subject.id);
  }
  const identity = object(data.identity, [
    "causationId",
    "correlationId",
    "settlementScopeId",
  ], ["actionScopeId"]);
  for (const value of Object.values(identity)) text(value);
  if (
    identity.causationId !== expected.sourceEventId ||
    identity.correlationId !== event.correlationId
  ) throw failure("local_processor_projection_invalid");
  const { reference: _reference, ...invocation } = data;
  return invocation as RegisteredProcessorInvocation;
}
/** Internal shared decoder; a valid ended receipt is not permission to retry. */
export function parseLocalProcessorAttemptReceipt(
  value: unknown,
  expected: OwnerLocalProcessorAssignmentBinding,
  ordinal: number,
  completion: RegisteredProcessorCompletion,
  maxAttempts: number | undefined,
): OwnerLocalProcessorAttemptReceipt {
  const receipt = object(value, ["reference", "attempts", "status"], [
    "availableAt",
  ]);
  exact(receipt.reference, expected);
  if (receipt.attempts !== ordinal) {
    throw failure("local_processor_completion_invalid");
  }
  const allowed = completion.status === "failed"
    ? completion.retryable ? ["retry_wait", "dead_letter"] : ["dead_letter"]
    : [completion.status];
  if (
    typeof receipt.status !== "string" || !allowed.includes(receipt.status)
  ) {
    throw failure("local_processor_completion_conflict");
  }
  if (receipt.status === "retry_wait") {
    if (maxAttempts === undefined || ordinal >= maxAttempts) {
      throw failure("local_processor_completion_invalid");
    }
    timestamp(receipt.availableAt);
  } else if (Object.hasOwn(receipt, "availableAt")) {
    throw failure("local_processor_completion_invalid");
  }
  return receipt as OwnerLocalProcessorAttemptReceipt;
}

function unknown(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<string, unknown>;
  return value.indeterminate === true || value.outcome === "unknown" ||
    value.execution === "indeterminate" ||
    ["owner_commit_unknown", "persistence_indeterminate"].includes(
      String(value.code),
    );
}

export function createRegisteredLocalProcessorExecution(
  options: RegisteredLocalProcessorOptions,
) {
  const expected = reference(options.reference);
  const ordinal = options.attemptOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw failure("local_processor_ordinal_invalid");
  }
  const { registry, createCapabilities, isCurrent, onIndeterminate } = options;
  const owner = options.owner;
  const start = owner.start.bind(owner);
  const project = owner.project.bind(owner);
  const execute = owner.execute.bind(owner);
  const invokeAction = owner.invokeAction?.bind(owner);
  const state = owner.settlementState.bind(owner);
  const complete = owner.complete.bind(owner);
  const seal = owner.sealInvocationCalls.bind(owner);
  const drain = owner.drainRawCalls.bind(owner);
  const command = new AbortController();
  const exposed = new AbortController();
  let cancelled = false;
  let revoked = false;
  let reason: unknown;
  let uncertain = false;
  let uncertainty: unknown;
  let open = false;
  let sealed = false;
  let sealError: unknown;
  let sealFailed = false;
  let maxAttempts: number | undefined;
  let running: Promise<RegisteredLocalProcessorResult> | undefined;
  let cleanup: Promise<void> | undefined;
  let resolveQuiescent!: () => void;
  const quiescent = new Promise<void>((resolve) => {
    resolveQuiescent = resolve;
  });
  const indeterminate = (error: unknown) => {
    if (!uncertain) {
      uncertain = true;
      uncertainty = Object.assign(
        failure("local_processor_indeterminate", error),
        { execution: "indeterminate" },
      );
      command.abort(uncertainty);
      exposed.abort(uncertainty);
      try {
        onIndeterminate(uncertainty);
      } catch { /* retain original uncertainty */ }
    }
    return uncertainty;
  };
  const current = () => {
    if (uncertain) throw uncertainty;
    if (!revoked) {
      let valid = false;
      try {
        valid = isCurrent() === true;
      } catch (error) {
        reason = failure("local_processor_authority_lost", error);
      }
      if (!valid) {
        revoked = true;
        reason ??= failure("local_processor_authority_lost");
        command.abort(reason);
        exposed.abort(reason);
      }
    }
    if (revoked) throw reason;
  };
  const check = () => {
    current();
    if (cancelled) throw failure("processor_cancelled");
    if (!open) throw failure("local_processor_context_closed");
  };
  const close = () => {
    open = false;
    exposed.abort();
    if (!sealed) {
      sealed = true;
      try {
        seal();
      } catch (error) {
        sealFailed = true;
        sealError = indeterminate(error);
      }
    }
    if (sealFailed) throw sealError;
  };
  const drainCalls = async () => {
    try {
      await drain();
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const finish = () =>
    cleanup ??= Promise.resolve().then(async () => {
      close();
      await drainCalls();
      command.abort();
      resolveQuiescent();
    });
  const cancellation = async () => {
    current();
    const result = await state({});
    current();
    try {
      const data = object(result, ["reference", "cancellationRequested"]);
      exact(data.reference, expected);
      if (typeof data.cancellationRequested !== "boolean") {
        throw failure("local_processor_settlement_invalid");
      }
      return data.cancellationRequested;
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const terminal = async (
    completion: RegisteredProcessorCompletion,
  ): Promise<OwnerLocalProcessorAttemptReceipt | undefined> => {
    current();
    let result: RegisteredLocalProcessorCompletionOutcome;
    try {
      result = await complete(snapshot(completion), {});
    } catch (error) {
      throw indeterminate(error);
    }
    current();
    try {
      const data = object(result, ["status"], ["reference", "result"]);
      if (data.status === "not-committed") {
        object(data, ["status", "reference"]);
        exact(data.reference, expected);
        return undefined;
      }
      object(data, ["status", "result"]);
      if (data.status !== "committed" && data.status !== "duplicate") {
        throw failure("local_processor_completion_invalid");
      }
      return parseLocalProcessorAttemptReceipt(
        data.result,
        expected,
        ordinal,
        completion,
        maxAttempts,
      );
    } catch (error) {
      throw indeterminate(error);
    }
  };
  const cancelledCompletion = (): RegisteredProcessorCompletion => ({
    status: "cancelled",
    code: "processor_cancelled",
  });
  const run = async (): Promise<RegisteredLocalProcessorResult> => {
    try {
      current();
      if (cancelled) throw failure("processor_cancelled");
      let started: Awaited<ReturnType<typeof start>>;
      try {
        started = await start({ signal: command.signal });
      } catch (error) {
        throw indeterminate(error);
      }
      current();
      try {
        const data = object(started, ["status", "result"]);
        const receipt = object(data.result, ["binding", "attempts"]);
        exact(receipt.binding, expected);
        if (data.status !== "committed" || receipt.attempts !== ordinal) {
          throw failure("local_processor_fresh_start_required");
        }
      } catch (error) {
        throw indeterminate(error);
      }
      let completion: RegisteredProcessorCompletion;
      try {
        if (cancelled) completion = cancelledCompletion();
        else {
          let value: OwnerLocalProcessorProjection;
          try {
            value = await project({ signal: command.signal });
          } catch (error) {
            throw indeterminate(error);
          }
          current();
          let invocation: RegisteredProcessorInvocation;
          try {
            invocation = parseLocalProcessorProjection(
              value,
              expected,
              ordinal,
            );
          } catch (error) {
            throw indeterminate(error);
          }
          maxAttempts = invocation.maxAttempts;
          if (cancelled) completion = cancelledCompletion();
          else {
            open = true;
            check();
            completion = await runRegisteredProcessorInvocation({
              registry,
              invocation,
              lifetime: {
                check,
                isCancelled: () => cancelled,
                commandSignal: command.signal,
                exposedSignal: exposed.signal,
              },
              calls: {
                ...(invokeAction
                  ? {
                    invokeAction: async (input, callOptions) => {
                      check();
                      try {
                        const result = await invokeAction(
                          snapshot(input),
                          callOptions,
                        );
                        check();
                        return snapshot(result);
                      } catch (error) {
                        if (unknown(error)) throw indeterminate(error);
                        current();
                        throw error;
                      }
                    },
                  }
                  : {}),
                execute: async (input, callOptions) => {
                  check();
                  let result: OwnerCommandOutcome;
                  try {
                    result = await execute(input, callOptions);
                  } catch (error) {
                    if (unknown(error)) throw indeterminate(error);
                    current();
                    throw error;
                  }
                  check();
                  try {
                    const data = object(result, ["status", "result"]);
                    if (
                      data.status !== "committed" && data.status !== "duplicate"
                    ) throw failure("local_processor_command_invalid");
                    return data as OwnerCommandOutcome;
                  } catch (error) {
                    throw indeterminate(error);
                  }
                },
              },
              createCapabilities: async () => {
                check();
                const capabilities = await createCapabilities({
                  registry,
                  reference: snapshot(expected),
                  invocation: snapshot(invocation),
                  signal: exposed.signal,
                });
                check();
                return capabilities;
              },
            });
            current();
          }
        }
      } catch (error) {
        if (unknown(error)) throw indeterminate(error);
        current();
        completion = cancelled
          ? cancelledCompletion()
          : { status: "failed", code: "processor_failed", retryable: true };
      } finally {
        close();
      }
      await drainCalls();
      current();
      if (await cancellation()) completion = cancelledCompletion();
      else if (cancelled || completion.status === "cancelled") {
        throw failure("local_processor_cancellation_unconfirmed");
      }
      const receipt = await terminal(completion);
      current();
      if (!receipt) throw failure("local_processor_completion_not_committed");
      return { status: "executed", completion, receipt };
    } catch (error) {
      if (unknown(error)) throw indeterminate(error);
      throw error;
    } finally {
      await finish();
    }
  };
  return {
    run(): Promise<RegisteredLocalProcessorResult> {
      return running ??= Promise.resolve().then(run);
    },
    cancelCommitted() {
      cancelled = true;
      command.abort();
      exposed.abort();
      try {
        close();
      } catch { /* sticky quarantine already recorded */ }
    },
    revoke(value: unknown = failure("local_processor_authority_lost")) {
      if (!revoked) {
        revoked = true;
        reason = value;
      }
      command.abort(reason);
      exposed.abort(reason);
      try {
        close();
      } catch { /* no failed seal certifies quiescence */ }
      if (!running) void finish().catch(() => {});
    },
    quiescent,
  };
}
