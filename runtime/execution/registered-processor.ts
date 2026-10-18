import { captureStreamCalls } from "./stream-capability.ts";
import { createRegisteredInvocationFailure } from "./registered-invocation.ts";
import type { OwnerSnapshotPort } from "../owner/connection.ts";
import { captureSnapshotCalls } from "./snapshot-capability.ts";
import {
  OWNER_COLLECTION_READ,
  parseOwnerCollectionReadRequest,
} from "./collection-read-call.ts";
import type { RegisteredInvocationCalls } from "./registered-invocation.ts";
/** Private no-database Processor execution over the same named owner calls on
 * embedded and connected hosts. Business identity belongs to the delivery. */
import type {
  RuntimeContextNamespaces,
  RuntimeIdentity,
} from "../actions/types.ts";
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
  OwnerReceipt,
} from "../owner/boundary.ts";
import type { ProcessorEvent } from "../plugins/processor.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { runRegisteredProcessorInvocation } from "./registered-processor-invocation.ts";
import type { RegisteredProcessorCompletion } from "./registered-invocation.ts";

export type RegisteredProcessorAssignment = Readonly<
  { assignmentId: string; sessionId: string }
>;
export type RegisteredProcessorReference = Readonly<
  { deliveryId: string; dispatchAttemptId: string }
>;
export type { RegisteredProcessorCompletion } from "./registered-invocation.ts";
export type RegisteredProcessorReceipt =
  & RegisteredProcessorReference
  & Readonly<{
    status: "succeeded" | "retry_wait" | "dead_letter" | "cancelled";
  }>;
export type RegisteredProcessorProjection = Readonly<{
  processorId: string;
  ownerId: string;
  workerId: string;
  namespace: string;
  databaseSchema: string;
  event: ProcessorEvent;
  attempts: number;
  maxAttempts: number;
  operationKey: string;
  identity: RuntimeIdentity;
}>;
export type RegisteredProcessorOwnerPort = Readonly<{
  readCollection?: RegisteredInvocationCalls["readCollection"];
  snapshots?: RegisteredInvocationCalls["snapshots"];
  streams?: RegisteredInvocationCalls["streams"];
  claim(
    assignment: RegisteredProcessorAssignment,
    options: OwnerCommandExecuteOptions,
  ): Promise<
    Readonly<
      {
        status: "committed" | "duplicate";
        result: RegisteredProcessorReference;
      }
    >
  >;
  project(
    reference: RegisteredProcessorReference,
    options: OwnerCommandExecuteOptions,
  ): Promise<RegisteredProcessorProjection>;
  complete(
    reference: RegisteredProcessorReference,
    completion: RegisteredProcessorCompletion,
    options: OwnerCommandExecuteOptions,
  ): Promise<
    Readonly<
      { status: "committed" | "duplicate"; result: RegisteredProcessorReceipt }
    >
  >;
  readCompletion(
    reference: RegisteredProcessorReference,
    options: OwnerCommandExecuteOptions,
  ): Promise<RegisteredProcessorReceipt | undefined>;
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  /** Parent-bound named invocation. The owner derives authority, original event,
   * scopes and canonical input. Never substitute root/ingress admission here. */
  prepareAction?(
    input: Readonly<
      {
        reference: RegisteredProcessorReference;
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
    input: Readonly<
      {
        reference: RegisteredProcessorReference;
        actionAlias: string;
        input: OwnerJson;
        operationKey: string;
      }
    >,
    options: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
}>;
export type RegisteredProcessorResult =
  | Readonly<
    {
      status: "executed";
      completion: RegisteredProcessorCompletion;
      receipt: RegisteredProcessorReceipt;
    }
  >
  | Readonly<{ status: "replayed"; receipt: RegisteredProcessorReceipt }>;
export const ownerProcessorOperationKey = (deliveryId: string) =>
  `delivery:${deliveryId}`;
export const ownerProcessorClaimKey = (
  ownerId: string,
  assignmentId: string,
  sessionId: string,
) => JSON.stringify(["processor.claim", ownerId, assignmentId, sessionId]);
export const ownerProcessorCompletionKey = (
  ownerId: string,
  ref: RegisteredProcessorReference,
) =>
  JSON.stringify([
    "processor.complete",
    ownerId,
    ref.deliveryId,
    ref.dispatchAttemptId,
  ]);
function failure(code: string) {
  return Object.assign(new Error(code), {
    name: "RegisteredProcessorError",
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
    throw failure("processor_data_limit");
  }
  return structuredClone(value);
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw failure("processor_identity_invalid");
}
function reference(value: unknown): RegisteredProcessorReference {
  const data = snapshot(value) as RegisteredProcessorReference;
  if (!data || typeof data !== "object" || Object.keys(data).length !== 2) {
    throw failure("processor_reference_invalid");
  }
  text(data.deliveryId);
  text(data.dispatchAttemptId);
  return {
    deliveryId: data.deliveryId,
    dispatchAttemptId: data.dispatchAttemptId,
  };
}
function same(
  actual: RegisteredProcessorReference,
  expected: RegisteredProcessorReference,
) {
  if (
    actual.deliveryId !== expected.deliveryId ||
    actual.dispatchAttemptId !== expected.dispatchAttemptId
  ) throw failure("processor_reference_invalid");
}
function receipt(
  value: unknown,
  expected: RegisteredProcessorReference,
): RegisteredProcessorReceipt {
  const data = snapshot(value) as RegisteredProcessorReceipt;
  if (
    !data || Object.keys(data).length !== 3 ||
    !["succeeded", "retry_wait", "dead_letter", "cancelled"].includes(
      data.status,
    )
  ) throw failure("processor_receipt_invalid");
  same(
    reference({
      deliveryId: data.deliveryId,
      dispatchAttemptId: data.dispatchAttemptId,
    }),
    expected,
  );
  return data;
}
/** One permanently bound data port for one authenticated Started assignment. */
export function createRegisteredProcessorOwnerPort(
  options: Readonly<{
    ownerId: string;
    port: Readonly<{
      snapshots?: OwnerSnapshotPort;
      streams?: RegisteredInvocationCalls["streams"];
      execute(
        command: OwnerCommand,
        options?: OwnerCommandExecuteOptions,
      ): Promise<OwnerCommandOutcome>;
      complete(
        command: OwnerCommand,
        options?: OwnerCommandExecuteOptions,
      ): Promise<OwnerCommandOutcome>;
      project(
        kind: string,
        input: OwnerJson,
        options?: OwnerCommandExecuteOptions,
      ): Promise<OwnerJson>;
      readReceipt(
        identity: Readonly<{ domain: "incarnation"; key: string }>,
        options?: OwnerCommandExecuteOptions,
      ): Promise<Pick<OwnerReceipt, "kind" | "result"> | undefined>;
    }>;
    invokeAction?: RegisteredProcessorOwnerPort["invokeAction"];
    prepareAction?: RegisteredProcessorOwnerPort["prepareAction"];
  }>,
): RegisteredProcessorOwnerPort {
  const { ownerId, port } = options;
  text(ownerId);
  let assignment: RegisteredProcessorAssignment | undefined;
  let claimed: RegisteredProcessorReference | undefined;
  let attempted = false;
  let projected = false;
  let closed = false;
  const refuse = (): never => {
    throw failure("processor_replay_refused");
  };
  const requireClaim = (ref: RegisteredProcessorReference) => {
    if (!claimed) refuse();
    same(ref, claimed!);
  };
  const readCompletion: RegisteredProcessorOwnerPort["readCompletion"] = async (
    value,
    callOptions,
  ) => {
    const ref = reference(value);
    const found = await port.readReceipt({
      domain: "incarnation",
      key: ownerProcessorCompletionKey(ownerId, ref),
    }, callOptions);
    if (!found) return undefined;
    if (found.kind !== "processor.complete") refuse();
    return receipt(found.result, ref);
  };
  const snapshots = captureSnapshotCalls(options.port.snapshots);
  const streams = captureStreamCalls(options.port.streams);
  return {
    ...(snapshots ? { snapshots } : {}),
    ...(streams ? { streams } : {}),
    async claim(hint, callOptions) {
      const input = snapshot(hint);
      text(input.assignmentId);
      text(input.sessionId);
      if (Object.keys(input).length !== 2) refuse();
      if (
        assignment &&
        (assignment.assignmentId !== input.assignmentId ||
          assignment.sessionId !== input.sessionId)
      ) refuse();
      assignment = input;
      const key = ownerProcessorClaimKey(
        ownerId,
        input.assignmentId,
        input.sessionId,
      );
      const prior = await port.readReceipt(
        { domain: "incarnation", key },
        callOptions,
      );
      if (prior) {
        if (prior.kind !== "processor.claim") refuse();
        const ref = reference(prior.result);
        if (!await readCompletion(ref, callOptions)) refuse();
        return { status: "duplicate", result: ref };
      }
      if (attempted) refuse();
      attempted = true;
      const outcome = await port.execute({
        kind: "processor.claim",
        domain: "incarnation",
        key,
        intent: input,
      }, callOptions);
      const ref = reference(outcome.result);
      if (outcome.status === "committed") claimed = ref;
      return { status: outcome.status, result: ref };
    },
    async project(value, callOptions) {
      const ref = reference(value);
      requireClaim(ref);
      if (closed || projected) refuse();
      const result = await port.project("processor.input", ref, callOptions);
      if (closed) refuse();
      projected = true;
      return result as unknown as RegisteredProcessorProjection;
    },
    async complete(value, result, callOptions) {
      const ref = reference(value);
      requireClaim(ref);
      closed = true;
      const outcome = await port.complete({
        kind: "processor.complete",
        domain: "incarnation",
        key: ownerProcessorCompletionKey(ownerId, ref),
        intent: { reference: ref, completion: snapshot(result) },
      }, callOptions);
      return { status: outcome.status, result: receipt(outcome.result, ref) };
    },
    readCompletion,
    execute: (command, callOptions) => port.execute(command, callOptions),
    async readCollection(request, options) {
      if (!projected || closed) refuse();
      const result = await port.project(
        OWNER_COLLECTION_READ,
        parseOwnerCollectionReadRequest(request) as unknown as OwnerJson,
        options,
      );
      if (!projected || closed) refuse();
      return result;
    },
    ...(options.invokeAction ? { invokeAction: options.invokeAction } : {}),
    ...(options.prepareAction ? { prepareAction: options.prepareAction } : {}),
  };
}

export function createRegisteredProcessorWorker(
  options: Readonly<{
    registry: PluginRegistry;
    owner: RegisteredProcessorOwnerPort;
    createCapabilities(
      input: Readonly<
        {
          registry: PluginRegistry;
          reference: RegisteredProcessorReference;
          projection: RegisteredProcessorProjection;
          signal: AbortSignal;
        }
      >,
    ):
      | Readonly<
        {
          resources: RuntimeContextNamespaces;
          adapters: RuntimeContextNamespaces;
        }
      >
      | Promise<
        Readonly<
          {
            resources: RuntimeContextNamespaces;
            adapters: RuntimeContextNamespaces;
          }
        >
      >;
    maxAssignments?: number;
  }>,
) {
  const { registry, owner: port, createCapabilities } = options;
  const limit = options.maxAssignments ?? 128;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Invalid Processor assignment capacity.");
  }
  type Entry = {
    pending?: Promise<RegisteredProcessorResult>;
    failed?: Promise<RegisteredProcessorResult>;
    receipt?: RegisteredProcessorReceipt;
  };
  const assignments = new Map<string, Entry>();
  async function run(
    hint: RegisteredProcessorAssignment,
    signal?: AbortSignal,
  ): Promise<RegisteredProcessorResult> {
    const control = new AbortController();
    const exposed = new AbortController();
    const invocationFailure = createRegisteredInvocationFailure(
      control,
      exposed,
    );
    let cancelled = signal?.aborted ?? false;
    let open = true;
    const cancel = () => {
      cancelled = true;
      control.abort();
      exposed.abort();
    };
    if (cancelled) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const check = () => {
      invocationFailure.check();
      if (cancelled) throw failure("processor_cancelled");
      if (!open) throw failure("processor_context_closed");
    };
    try {
      check();
      const claimed = await port.claim(snapshot(hint), {
        signal: control.signal,
      });
      if (!["committed", "duplicate"].includes(claimed.status)) {
        throw failure("processor_claim_invalid");
      }
      const ref = reference(claimed.result);
      if (claimed.status === "duplicate") {
        const recovered = await port.readCompletion(ref, {
          signal: control.signal,
        });
        if (!recovered) throw failure("processor_replay_refused");
        return { status: "replayed", receipt: receipt(recovered, ref) };
      }
      check();
      const projection = snapshot(
        await port.project(ref, { signal: control.signal }),
      );
      for (
        const value of [
          projection.processorId,
          projection.ownerId,
          projection.workerId,
          projection.namespace,
          projection.databaseSchema,
          projection.operationKey,
        ]
      ) text(value);
      if (
        !projection.event?.durable ||
        projection.event.namespace !== projection.namespace ||
        projection.operationKey !==
          ownerProcessorOperationKey(ref.deliveryId) ||
        projection.identity?.causationId !== projection.event.id ||
        projection.identity.correlationId !== projection.event.correlationId ||
        !Number.isSafeInteger(projection.attempts) || projection.attempts < 1 ||
        !Number.isSafeInteger(projection.maxAttempts) ||
        projection.maxAttempts < projection.attempts
      ) throw failure("processor_projection_invalid");
      check();

      const invokeAction = port.invokeAction?.bind(port);
      const prepareAction = port.prepareAction?.bind(port);
      const execute = port.execute.bind(port);
      const readCollection = port.readCollection?.bind(port);
      const snapshots = captureSnapshotCalls(port.snapshots);
      const streams = captureStreamCalls(port.streams);
      let result: RegisteredProcessorCompletion;
      try {
        result = await runRegisteredProcessorInvocation({
          registry,
          invocation: {
            processorId: projection.processorId,
            ownerId: projection.ownerId,
            namespace: projection.namespace,
            databaseSchema: projection.databaseSchema,
            deliveryId: ref.deliveryId,
            event: projection.event,
            attempts: projection.attempts,
            maxAttempts: projection.maxAttempts,
            operationKey: projection.operationKey,
            identity: projection.identity,
          },
          lifetime: {
            check,
            fail: invocationFailure.fail,
            isCancelled: () => cancelled,
            commandSignal: control.signal,
            exposedSignal: exposed.signal,
          },
          calls: {
            execute,
            ...(readCollection ? { readCollection } : {}),
            ...(snapshots ? { snapshots } : {}),
            ...(streams ? { streams } : {}),
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
          createCapabilities: () =>
            createCapabilities({
              registry,
              reference: snapshot(ref),
              projection: snapshot(projection),
              signal: exposed.signal,
            }),
        });
      } finally {
        open = false;
        exposed.abort();
      }
      const ack = await port.complete(
        snapshot(ref),
        snapshot(result),
        cancelled || invocationFailure.failed ? {} : { signal: control.signal },
      );
      if (!["committed", "duplicate"].includes(ack.status)) {
        throw failure("processor_completion_invalid");
      }
      const completed = receipt(ack.result, ref);
      if (
        (result.status === "succeeded" && completed.status !== "succeeded") ||
        (result.status === "cancelled" && completed.status !== "cancelled") ||
        (result.status === "failed" &&
          !["retry_wait", "dead_letter"].includes(completed.status))
      ) throw failure("processor_completion_conflict");
      return { status: "executed", completion: result, receipt: completed };
    } finally {
      open = false;
      exposed.abort();
      signal?.removeEventListener("abort", cancel);
    }
  }
  return {
    execute(
      assignment: RegisteredProcessorAssignment,
      callOptions: OwnerCommandExecuteOptions = {},
    ): Promise<RegisteredProcessorResult> {
      const hint = snapshot(assignment);
      text(hint.assignmentId);
      text(hint.sessionId);
      if (Object.keys(hint).length !== 2) {
        return Promise.reject(failure("processor_assignment_invalid"));
      }
      const key = JSON.stringify([hint.sessionId, hint.assignmentId]);
      const existing = assignments.get(key);
      if (existing?.pending) return existing.pending;
      if (existing?.failed) return existing.failed;
      if (existing?.receipt) {
        const ref = reference({
          deliveryId: existing.receipt.deliveryId,
          dispatchAttemptId: existing.receipt.dispatchAttemptId,
        });
        const recovery = (async (): Promise<RegisteredProcessorResult> => {
          const result = await port.readCompletion(ref, callOptions);
          if (!result) throw failure("processor_replay_refused");
          return { status: "replayed", receipt: receipt(result, ref) };
        })();
        existing.pending = recovery;
        void recovery.then(() => {
          existing.pending = undefined;
        }, () => {
          existing.pending = undefined;
        });
        return recovery;
      }
      if (assignments.size >= limit) {
        return Promise.reject(failure("processor_capacity"));
      }
      const task = run(hint, callOptions.signal);
      const entry: Entry = { pending: task };
      assignments.set(key, entry);
      void task.then((result) => {
        entry.receipt = snapshot(result.receipt);
        entry.pending = undefined;
      }, () => {
        entry.failed = task;
        entry.pending = undefined;
      });
      return task;
    },
  };
}
