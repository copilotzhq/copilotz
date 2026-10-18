import { createLocalStreamPort } from "./local-stream-port.ts";
import type { RegisteredStreamPort } from "../execution/stream-capability.ts";
import {
  createLocalSnapshotPort,
  type LocalSnapshotResources,
} from "./local-snapshot-port.ts";
import {
  OWNER_COLLECTION_READ,
  parseOwnerCollectionReadRequest,
} from "../execution/collection-read-call.ts";
/** Private actual-boundary adapter for one local Processor attempt. No scheduler,
 * host activation, retry generation, receipt recovery or noncommit inference. */
import { assertJsonValue } from "../json.ts";
import { createLocalPortCalls } from "./local-port-calls.ts";
import {
  createLocalChildActionCalls,
  type LocalChildActionOptions,
} from "./local-child-action-port.ts";
import {
  parseLocalProcessorAttemptReceipt,
  parseLocalProcessorProjection,
  type RegisteredLocalProcessorPort,
} from "../execution/registered-local-processor.ts";
import {
  type OwnerLocalProcessorAttemptReceipt,
  ownerLocalProcessorCompletionKey,
  type OwnerLocalProcessorProjection,
  ownerLocalProcessorStartKey,
  type OwnerLocalProcessorStartReceipt,
} from "./processor.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "./placement-binding.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
  OwnerJson,
} from "./boundary.ts";
import { parseOwnerPlacementBinding } from "./placement-binding.ts";
import { assertOwnerAttemptCaller } from "./attempt-authority.ts";
import { ownerPrincipalIdentity } from "./principal.ts";

function failure(code: string, cause?: unknown): Error & { code: string } {
  return Object.assign(new Error(code, { cause }), {
    name: "OwnerLocalProcessorPortError",
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
function localReference(value: unknown): OwnerLocalProcessorAssignmentBinding {
  const result = parseOwnerPlacementBinding(value);
  if (
    result.placement !== "owner-local" || result.kind !== "processor" ||
    result.consumerId !== `processor:${result.processorId}`
  ) {
    throw failure("owner_local_port_reference_invalid");
  }
  return result;
}

export function createOwnerLocalProcessorPort(
  options: Readonly<{
    snapshots?: LocalSnapshotResources;
    streams?: RegisteredStreamPort;
    boundary:
      & Pick<
        OwnerCommandBoundary,
        "execute" | "project"
      >
      & Partial<Pick<OwnerCommandBoundary, "executeInput">>;
    reference: OwnerLocalProcessorAssignmentBinding;
    attemptOrdinal: number;
    /** Actual pre-authorized host principals, including their private witnesses.
     * They never appear in intent and are independently checked by the owner. */
    controlCaller: OwnerCaller;
    localCaller: OwnerCaller;
    /** Exact private entry lifetime, distinct from ctx/settlement policy grants. */
    isCurrent(): boolean;
    /** Synchronous private hooks. A known reply is recorded before the final
     * lifetime check; neither hook releases occupancy or grants SQL authority. */
    onStarted(receipt: OwnerLocalProcessorStartReceipt): void;
    onEnded(receipt: OwnerLocalProcessorAttemptReceipt): void;
    maxPendingCalls?: number;
    children?: LocalChildActionOptions;
  }>,
): RegisteredLocalProcessorPort {
  const reference = localReference(options.reference);
  const ordinal = options.attemptOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw failure("owner_local_port_ordinal_invalid");
  }
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
  const project = boundary.project.bind(boundary);
  const isCurrent = options.isCurrent;
  const onStarted = options.onStarted;
  const onEnded = options.onEnded;
  const limit = Object.hasOwn(options, "maxPendingCalls")
    ? options.maxPendingCalls!
    : 32;
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
  let maxAttempts: number | undefined;
  let startPromise:
    | ReturnType<RegisteredLocalProcessorPort["start"]>
    | undefined;
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
  const executeInput = boundary.executeInput?.bind(boundary);
  if (children && !executeInput) {
    throw new TypeError("Local children require owner input admission.");
  }
  const streams = createLocalStreamPort({
    port: options.streams,
    calls,
    invocation,
    settlement,
  });
  const snapshots = createLocalSnapshotPort({
    resources: options.snapshots,
    caller: localCaller,
    calls,
    check: invocation,
  });
  return {
    ...(snapshots ? { snapshots } : {}),
    ...(streams ? { streams } : {}),
    async readCollection(request, callOptions) {
      invocation();
      const input = parseOwnerCollectionReadRequest(
        request,
      ) as unknown as OwnerJson;
      const result = await calls.run(
        (execution) =>
          project(copy(localCaller), OWNER_COLLECTION_READ, input, execution),
        callOptions,
      );
      invocation();
      return copy(result);
    },
    ...(children
      ? createLocalChildActionCalls({
        children,
        reference,
        caller: localCaller,
        boundary: { executeInput: executeInput!, project },
        calls,
        invocation,
        maxPendingCalls: limit,
      })
      : {}),
    start(callOptions = {}) {
      if (startPromise) return startPromise;
      let resolve!: (
        value: Awaited<ReturnType<RegisteredLocalProcessorPort["start"]>>,
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
                kind: "owner.local-processor-start",
                domain: "incarnation",
                key: ownerLocalProcessorStartKey(reference),
                intent: copy(reference),
              }, execution), { ...callOptions }),
          );
          const result = object(value.result, ["binding", "attempts"]);
          const binding = exact(result.binding);
          if (value.status !== "committed" || result.attempts !== ordinal) {
            throw failure("owner_local_port_fresh_start_required");
          }
          // Record a raw known start even if revocation raced its reply.
          const receipt = { binding, attempts: ordinal };
          calls.observeHook(onStarted, receipt);
          started = true;
          current();
          return {
            status: "committed",
            result: receipt,
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
            "processor.local-input",
            copy(reference),
            execution,
          ),
        callOptions,
      );
      invocation();
      try {
        const value = copy(result) as OwnerLocalProcessorProjection;
        const decoded = parseLocalProcessorProjection(
          value,
          reference,
          ordinal,
        );
        maxAttempts = decoded.maxAttempts;
        return { reference: copy(reference), ...decoded };
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
        !value.key.startsWith(`delivery:${reference.deliveryId}:`) ||
        value.key.length <= `delivery:${reference.deliveryId}:`.length
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
            "processor.local-settlement-state",
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
            execute(copy(localCaller), {
              kind: "processor.local-complete",
              domain: "incarnation",
              key: ownerLocalProcessorCompletionKey(reference),
              intent: { reference: copy(reference), completion: submitted },
            }, execution), callOptions),
        );
        const receipt = parseLocalProcessorAttemptReceipt(
          result.result,
          reference,
          ordinal,
          submitted,
          maxAttempts,
        );
        terminalKnown = true;
        // Keep a known ended-attempt fact even if private lifetime revocation
        // raced its reply. It does not reactivate the attempt or grant retry.
        calls.observeHook(onEnded, receipt);
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
