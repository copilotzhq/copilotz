/** Private actual-boundary adapter for one fresh local Action. No scheduler,
 * host activation, receipt recovery or noncommit inference. */
import { assertJsonValue } from "../json.ts";
import { createLocalPortCalls } from "./local-port-calls.ts";
import {
  intent as effectIntent,
  ownerEffectKey,
  type OwnerEffectOperation,
  type OwnerEffectPort,
  type OwnerEffectReference,
  record as effectRecord,
} from "./effects-client.ts";
import {
  createLocalChildActionCalls,
  type LocalChildActionOptions,
} from "./local-child-action-port.ts";
import type {
  RegisteredLocalActionPort,
  RegisteredLocalActionReceipt,
  RegisteredLocalActionReference,
} from "../execution/registered-local.ts";
import { ownerCompletionKey } from "../execution/owner-port.ts";
import {
  type OwnerLocalActionProjection,
  ownerLocalActionStartKey,
} from "./execution.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
} from "./boundary.ts";
import { parseOwnerPlacementBinding } from "./placement-binding.ts";
import { assertOwnerAttemptCaller } from "./attempt-authority.ts";
import { ownerPrincipalIdentity } from "./principal.ts";

function failure(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code, { cause }), {
    name: "OwnerLocalActionPortError",
    code,
  });
}
function copy<T>(value: T): T {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) {
    throw failure("owner_local_port_data_limit");
  }
  return structuredClone(value);
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const data = copy(value);
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) throw failure("owner_local_port_data_invalid");
  return data as Record<string, unknown>;
}
function localReference(value: unknown): RegisteredLocalActionReference {
  const result = parseOwnerPlacementBinding(value);
  if (result.placement !== "owner-local" || result.kind !== "action") {
    throw failure("owner_local_port_reference_invalid");
  }
  return result;
}

export function createOwnerLocalActionPort(
  options: Readonly<{
    boundary: Pick<
      OwnerCommandBoundary,
      "execute" | "executeInput" | "project"
    >;
    reference: RegisteredLocalActionReference;
    /** Actual pre-authorized host principals, including their private witnesses.
     * They never appear in intent and are independently checked by the owner. */
    controlCaller: OwnerCaller;
    localCaller: OwnerCaller;
    /** Exact private entry lifetime, distinct from ctx/settlement policy grants. */
    isCurrent(): boolean;
    /** Synchronous private hooks. A known reply is recorded before the final
     * lifetime check; neither hook releases occupancy or grants SQL authority. */
    onStarted(reference: RegisteredLocalActionReference): void;
    onTerminal(receipt: RegisteredLocalActionReceipt): void;
    maxPendingCalls?: number;
    children?: LocalChildActionOptions;
  }>,
): RegisteredLocalActionPort {
  const reference = localReference(options.reference);
  const controlCaller = copy(options.controlCaller);
  const localCaller = copy(options.localCaller);
  const control = controlCaller.principal;
  ownerPrincipalIdentity(control);
  if (
    control.kind !== "owner-control" || control.ownerId !== reference.ownerId ||
    control.epoch !== reference.epoch ||
    control.holderId !== reference.holderId ||
    controlCaller.ownerEpoch !== reference.epoch ||
    Object.hasOwn(controlCaller, "workerId") ||
    Object.hasOwn(localCaller, "workerId")
  ) throw failure("owner_local_port_control_invalid");
  assertOwnerAttemptCaller(localCaller, reference, reference.ownerId);
  const children = options.children;
  const boundary = options.boundary;
  const execute = boundary.execute.bind(boundary);
  const executeInput = boundary.executeInput.bind(boundary);
  const project = boundary.project.bind(boundary);
  const isCurrent = options.isCurrent;
  const onStarted = options.onStarted;
  const onTerminal = options.onTerminal;
  const limit = options.maxPendingCalls ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128) {
    throw new TypeError("Local raw calls require a bound between 1 and 128.");
  }
  const loss = new AbortController();
  let closed = false;
  let lost = false;
  let lostReason: unknown;
  let started = false;
  let completionSubmitted = false;
  let terminalKnown = false;
  let startPromise: ReturnType<RegisteredLocalActionPort["start"]> | undefined;
  const quarantine = (error: unknown): unknown => {
    if (!lost) {
      lost = true;
      lostReason = Object.assign(
        failure("owner_local_port_indeterminate", error),
        {
          indeterminate: true,
        },
      );
      loss.abort(lostReason);
    }
    return lostReason;
  };
  const current = () => {
    if (!lost) {
      let granted = false;
      try {
        granted = isCurrent() === true;
      } catch (error) {
        lostReason = failure("owner_local_port_authority_lost", error);
      }
      if (!granted) {
        lost = true;
        lostReason ??= failure("owner_local_port_authority_lost");
        loss.abort(lostReason);
      }
    }
    if (lost) throw lostReason;
  };
  const invocation = () => {
    current();
    if (!started || closed || completionSubmitted) {
      throw failure("owner_local_port_context_closed");
    }
  };
  const settlement = () => {
    current();
    if (!started || terminalKnown) {
      throw failure("owner_local_port_settlement_closed");
    }
  };
  const exact = (value: unknown) => {
    const actual = localReference(value);
    if (JSON.stringify(actual) !== JSON.stringify(reference)) {
      throw failure("owner_local_port_reference_invalid");
    }
    return actual;
  };
  const outcome = (value: unknown): OwnerCommandOutcome => {
    const data = object(value, ["status", "result"]);
    if (data.status !== "committed" && data.status !== "duplicate") {
      throw failure("owner_local_port_outcome_invalid");
    }
    return data as OwnerCommandOutcome;
  };
  const calls = createLocalPortCalls({
    current,
    quarantine,
    failure,
    snapshot: copy,
    signal: loss.signal,
    maxPendingCalls: limit,
  });
  const effectReference = (
    value: unknown,
    operation?: OwnerEffectOperation,
  ) => {
    const data = effectIntent(value, operation);
    if (
      data.ref.namespace !== reference.namespace ||
      data.ref.actionRunId !== reference.actionRunId
    ) {
      throw failure("owner_local_port_effect_refused");
    }
    return data.ref;
  };
  const effectAccess = (begin: boolean) => {
    if (begin) invocation();
    else settlement();
    if (completionSubmitted) throw failure("owner_local_port_effect_closed");
  };
  const effectCommand = async (
    command: OwnerCommand,
    operation: OwnerEffectOperation,
    callOptions: Parameters<OwnerEffectPort["execute"]>[1],
  ): Promise<OwnerCommandOutcome> => {
    effectAccess(operation === "begin");
    const value = object(command, ["kind", "domain", "key", "intent"]);
    const target = effectReference(value.intent, operation);
    if (
      value.kind !== `effect.${operation}` || value.domain !== "logical" ||
      value.key !== ownerEffectKey(reference.ownerId, target, operation)
    ) {
      throw failure("owner_local_port_effect_refused");
    }
    const result = await calls.run(
      (execution) =>
        execute(copy(localCaller), value as OwnerCommand, execution),
      callOptions,
    );
    effectAccess(operation === "begin");
    try {
      const known = outcome(result);
      const record = effectRecord(known.result, target);
      if (
        record.status !==
          (operation === "begin"
            ? "begun"
            : operation === "confirm"
            ? "confirmed"
            : "not_started")
      ) {
        throw failure("owner_local_port_effect_outcome_invalid");
      }
      return known;
    } catch (error) {
      throw quarantine(error);
    }
  };
  const effects: OwnerEffectPort = {
    execute: (command, callOptions) =>
      effectCommand(command, "begin", callOptions),
    settle(command, callOptions) {
      const value = object(command, ["kind", "domain", "key", "intent"]);
      if (
        value.kind !== "effect.confirm" && value.kind !== "effect.notStarted"
      ) {
        throw failure("owner_local_port_effect_refused");
      }
      const operation = value.kind === "effect.confirm"
        ? "confirm"
        : "notStarted";
      return effectCommand(value as OwnerCommand, operation, callOptions);
    },
    async project(kind, input, callOptions) {
      effectAccess(false);
      if (kind !== "effect.state") {
        throw failure("owner_local_port_effect_refused");
      }
      const target: OwnerEffectReference = effectReference(input);
      const result = await calls.run(
        (execution) =>
          project(copy(localCaller), kind, copy(target), execution),
        callOptions,
      );
      effectAccess(false);
      try {
        return effectRecord(result, target);
      } catch (error) {
        throw quarantine(error);
      }
    },
  };
  return {
    effects,
    ...(children
      ? createLocalChildActionCalls({
        children,
        reference,
        caller: localCaller,
        boundary: { executeInput, project },
        calls,
        invocation,
        maxPendingCalls: limit,
      })
      : {}),
    start(callOptions = {}) {
      if (startPromise) return startPromise;
      let resolve!: (
        value: Awaited<ReturnType<RegisteredLocalActionPort["start"]>>,
      ) => void;
      let reject!: (error: unknown) => void;
      // Publish the one-shot result before invoking a reentrant raw boundary,
      // but admit and charge its work in this same synchronous call stack.
      startPromise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const result = (async () => {
        current();
        if (closed) throw failure("owner_local_port_context_closed");
        try {
          const value = outcome(
            await calls.run((execution) =>
              execute(copy(controlCaller), {
                kind: "owner.local-start",
                domain: "incarnation",
                key: ownerLocalActionStartKey(reference),
                intent: copy(reference),
              }, execution), { ...callOptions }),
          );
          const result = object(value.result, ["binding", "attempts"]);
          const binding = exact(result.binding);
          if (value.status !== "committed" || result.attempts !== 1) {
            throw failure("owner_local_port_fresh_start_required");
          }
          // Record a raw known start even if revocation raced its reply.
          calls.observeHook(onStarted, binding);
          started = true;
          current();
          return {
            status: "committed",
            result: { binding, attempts: 1 },
          } as const;
        } catch (error) {
          throw quarantine(error);
        }
      })();
      result.then(resolve, reject);
      return startPromise;
    },
    async project(callOptions = {}) {
      invocation();
      const result = await calls.run(
        (execution) =>
          project(
            copy(localCaller),
            "execution.input",
            copy(reference),
            execution,
          ),
        callOptions,
      );
      invocation();
      try {
        const value = copy(result) as OwnerLocalActionProjection;
        exact(value.reference);
        return value;
      } catch (error) {
        throw quarantine(error);
      }
    },
    async execute(command, callOptions = {}) {
      invocation();
      const value = object(command, ["kind", "domain", "key", "intent"]);
      if (
        value.kind !== "collections" || value.domain !== "logical" ||
        typeof value.key !== "string" ||
        !value.key.startsWith(`${reference.actionRunId}/`) ||
        value.key.length <= reference.actionRunId.length + 1
      ) throw failure("owner_local_port_command_refused");
      const result = await calls.run(
        (execution) =>
          execute(copy(localCaller), value as OwnerCommand, execution),
        callOptions,
      );
      invocation();
      try {
        return outcome(result);
      } catch (error) {
        throw quarantine(error);
      }
    },
    async settlementState(callOptions = {}) {
      settlement();
      const result = await calls.run(
        (execution) =>
          project(
            copy(localCaller),
            "execution.local-settlement-state",
            copy(reference),
            execution,
          ),
        callOptions,
      );
      settlement();
      try {
        const value = object(result, ["reference", "cancellationRequested"]);
        const binding = exact(value.reference);
        if (typeof value.cancellationRequested !== "boolean") {
          throw failure("owner_local_port_settlement_invalid");
        }
        return {
          reference: binding,
          cancellationRequested: value.cancellationRequested,
        };
      } catch (error) {
        throw quarantine(error);
      }
    },
    async complete(completion, callOptions = {}) {
      settlement();
      if (!closed || completionSubmitted || calls.size) {
        throw failure("owner_local_port_completion_refused");
      }
      completionSubmitted = true;
      try {
        const submitted = copy(completion);
        const result = outcome(
          await calls.run((execution) =>
            executeInput(copy(localCaller), {
              kind: "execution.complete",
              domain: "logical",
              key: ownerCompletionKey(
                reference.ownerId,
                reference.namespace,
                reference.actionRunId,
              ),
              input: {
                namespace: reference.namespace,
                executionId: reference.actionRunId,
                completion: submitted,
              },
            }, execution), callOptions),
        );
        const value = object(result.result, ["reference", "status"]);
        const binding = exact(value.reference);
        if (value.status !== submitted.status) {
          throw failure("owner_local_port_completion_invalid");
        }
        const receipt = { reference: binding, status: submitted.status };
        terminalKnown = true;
        calls.observeHook(onTerminal, receipt);
        current();
        return { status: result.status, result: receipt };
      } catch (error) {
        // The boundary's thrown errors carry no exact per-call rollback proof.
        // This adapter NEVER manufactures the driver's not-committed witness.
        throw quarantine(error);
      }
    },
    sealInvocationCalls() {
      closed = true;
    },
    async drainRawCalls() {
      await calls.drain();
    },
  };
}
