/** Private no-database Processor execution over the same named owner calls on
 * embedded and connected hosts. Business identity belongs to the delivery. */
import type {
  ActionCallOptions,
  ActionTransactionOptions,
  RuntimeContext,
  RuntimeContextNamespaces,
  RuntimeIdentity,
} from "../actions/types.ts";
import { isNonRetryableError } from "../failure.ts";
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
  OwnerReceipt,
} from "../owner/boundary.ts";
import {
  createOwnerTransactionPlanner,
  type OwnerTransactionContext,
} from "../owner/transaction.ts";
import { matchProcessor } from "../plugins/match.ts";
import type {
  Processor,
  ProcessorContext,
  ProcessorEvent,
} from "../plugins/processor.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { createExecutionHeartbeat } from "./execution-heartbeat.ts";

export type RegisteredProcessorAssignment = Readonly<
  { assignmentId: string; sessionId: string }
>;
export type RegisteredProcessorReference = Readonly<
  { deliveryId: string; dispatchAttemptId: string }
>;
export type RegisteredProcessorCompletion =
  | Readonly<{ status: "succeeded" }>
  | Readonly<{ status: "cancelled"; code: "processor_cancelled" }>
  | Readonly<{ status: "failed"; code: string; retryable: boolean }>;
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
  lease: Readonly<{ remainingMs: number; renewAfterMs: number }>;
  operationKey: string;
  identity: RuntimeIdentity;
}>;
export type RegisteredProcessorRenewal =
  & RegisteredProcessorReference
  & Readonly<{ lease: RegisteredProcessorProjection["lease"] }>;
export type RegisteredProcessorOwnerPort = Readonly<{
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
  renew(
    reference: RegisteredProcessorReference,
    options: OwnerCommandExecuteOptions,
  ): Promise<
    Readonly<
      { status: "committed" | "duplicate"; result: RegisteredProcessorRenewal }
    >
  >;
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
export const ownerProcessorRenewalKey = (
  ownerId: string,
  assignmentId: string,
  sessionId: string,
  sequence: number,
) =>
  JSON.stringify([
    "processor.renew",
    ownerId,
    assignmentId,
    sessionId,
    sequence,
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
function unknownOutcome(error: unknown) {
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

/** One permanently bound data port for one authenticated Started assignment. */
export function createRegisteredProcessorOwnerPort(
  options: Readonly<{
    ownerId: string;
    port: Readonly<{
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
  }>,
): RegisteredProcessorOwnerPort {
  const { ownerId, port } = options;
  text(ownerId);
  let assignment: RegisteredProcessorAssignment | undefined;
  let claimed: RegisteredProcessorReference | undefined;
  let attempted = false;
  let projected = false;
  let closed = false;
  let renewing = false;
  let sequence = 0;
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
  return {
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
    async renew(value, callOptions) {
      const ref = reference(value);
      requireClaim(ref);
      if (
        closed || !projected || renewing || !assignment ||
        sequence >= Number.MAX_SAFE_INTEGER
      ) refuse();
      renewing = true;
      const next = ++sequence;
      try {
        const outcome = await port.execute({
          kind: "processor.renew",
          domain: "occurrence",
          key: ownerProcessorRenewalKey(
            ownerId,
            assignment!.assignmentId,
            assignment!.sessionId,
            next,
          ),
          intent: { reference: ref, sequence: next },
        }, callOptions);
        const result = snapshot(outcome.result) as RegisteredProcessorRenewal;
        if (closed || !result || Object.keys(result).length !== 3) refuse();
        same(
          reference({
            deliveryId: result.deliveryId,
            dispatchAttemptId: result.dispatchAttemptId,
          }),
          ref,
        );
        return { status: outcome.status, result };
      } catch (error) {
        closed = true;
        throw error;
      } finally {
        renewing = false;
      }
    },
    async complete(value, result, callOptions) {
      const ref = reference(value);
      requireClaim(ref);
      if (renewing) refuse();
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
    ...(options.invokeAction ? { invokeAction: options.invokeAction } : {}),
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
    let cancelled = signal?.aborted ?? false;
    let open = true;
    let renewalFailure: unknown;
    let renewalFailed = false;
    let heartbeat:
      | ReturnType<
        typeof createExecutionHeartbeat<RegisteredProcessorReference>
      >
      | undefined;
    const cancel = () => {
      cancelled = true;
      heartbeat?.requestStop();
      control.abort();
      exposed.abort();
    };
    if (cancelled) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
    const check = () => {
      if (cancelled) throw failure("processor_cancelled");
      if (!open) throw failure("processor_context_closed");
      if (renewalFailed) throw renewalFailure;
      heartbeat?.check();
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
      const started = performance.now();
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
      heartbeat = createExecutionHeartbeat({
        reference: ref,
        lease: projection.lease,
        started,
        renew: (value, callOptions) => port.renew(value, callOptions),
        validate(value, expected) {
          if (!value || Object.keys(value).length !== 3) {
            throw failure("processor_reference_invalid");
          }
          same(
            reference({
              deliveryId: value.deliveryId,
              dispatchAttemptId: value.dispatchAttemptId,
            }),
            expected,
          );
        },
        fail(error) {
          renewalFailed = true;
          renewalFailure = error;
          control.abort(error);
          exposed.abort();
        },
      });
      let registering = true;
      let capabilityFailure = false;
      let pendingFailure: unknown;
      let hasPendingFailure = false;
      let pendingFailures: unknown[] = [];
      const pending: Promise<unknown>[] = [];
      const unsupported = (): never => {
        capabilityFailure = true;
        throw failure("processor_capability_unsupported");
      };
      const unavailable = () => new Proxy({}, { get: unsupported });
      const supported = <T extends object>(target: T): T =>
        new Proxy(target, {
          get: (value, property) =>
            Object.hasOwn(value, property)
              ? Reflect.get(value, property)
              : unsupported(),
        });
      const plannedCollections = (
        context: OwnerTransactionContext<typeof registry.collections>,
      ) =>
        supported(Object.fromEntries(
          Object.entries(registry.collections).map(([alias, definition]) => {
            const collection = context.collections[alias];
            const method = <T extends (...args: never[]) => unknown>(
              call: T,
            ): T =>
              new Proxy(call, {
                get: unsupported,
                apply(target, receiver, args) {
                  if (definition.content?.fields.length || args.length > 1) {
                    return unsupported();
                  }
                  return Reflect.apply(target, receiver, args);
                },
              });
            return [
              alias,
              supported({
                create: method(collection.create),
                update: method(collection.update),
                delete: method(collection.delete),
                commands: supported(Object.fromEntries(
                  Object.keys(definition.commands ?? {}).map((
                    name,
                  ) => [name, method(collection.commands[name])]),
                )),
              }),
            ];
          }),
        ));
      const track = <T>(start: () => Promise<T>): Promise<T> => {
        check();
        if (!registering) throw failure("processor_context_closed");
        if (pending.length >= 100) return unsupported();
        let task: Promise<T>;
        try {
          task = start();
        } catch (error) {
          task = Promise.reject(error);
        }
        pending.push(task.catch((error) => {
          pendingFailures.push(error);
          if (!hasPendingFailure || unknownOutcome(error)) {
            hasPendingFailure = true;
            pendingFailure = error;
          }
        }));
        return task;
      };
      const planner = createOwnerTransactionPlanner({
        collections: registry.collections,
        identity: {
          ownerId: projection.ownerId,
          workerId: projection.workerId,
          invocationId: ref.deliveryId,
        },
        execute(command, callOptions) {
          check();
          if (capabilityFailure) return unsupported();
          return port.execute(command, callOptions);
        },
      });
      let transactionIndex = 0;
      let actionIndex = 0;
      const transaction: RuntimeContext["transaction"] = (
        callback,
        callOptions: ActionTransactionOptions = {},
      ) => {
        if (callOptions.identity !== undefined) return unsupported();
        const localKey = callOptions.operationKey ??
          `transaction:${++transactionIndex}`;
        text(localKey);
        return track(() =>
          planner({
            operationKey: `${projection.operationKey}:${localKey}`,
            signal: callOptions.signal
              ? AbortSignal.any([control.signal, callOptions.signal])
              : control.signal,
            execute: (context) =>
              callback(
                {
                  ...context,
                  collections: plannedCollections(context),
                  relations: unavailable(),
                  vectors: unavailable(),
                } as never,
              ),
          }).then(({ value }) => value)
        );
      };
      let result: RegisteredProcessorCompletion;
      try {
        const processor = Object.values(registry.processors).find((item) =>
          item.id === projection.processorId
        ) as Processor | undefined;
        if (
          !processor ||
          !matchProcessor(processor, projection.event, projection.event.data)
        ) throw failure("processor_unavailable");
        const capabilities = await createCapabilities({
          registry,
          reference: snapshot(ref),
          projection: snapshot(projection),
          signal: exposed.signal,
        });
        check();
        const actions = Object.fromEntries(
          Object.keys(registry.actions).map((
            actionAlias,
          ) => [
            actionAlias,
            new Proxy(
              (input: unknown, callOptions: ActionCallOptions = {}) => {
                if (
                  !port.invokeAction || callOptions.identity !== undefined ||
                  callOptions.metadata !== undefined
                ) return unsupported();
                const localKey = callOptions.operationKey?.trim() ||
                  String(++actionIndex);
                text(localKey);
                return track(() =>
                  port.invokeAction!({
                    reference: snapshot(ref),
                    actionAlias,
                    input: snapshot(input) as OwnerJson,
                    operationKey: localKey,
                  }, {
                    signal: callOptions.signal
                      ? AbortSignal.any([control.signal, callOptions.signal])
                      : control.signal,
                  })
                );
              },
              { get: unsupported },
            ),
          ]),
        );
        const directCollections = Object.fromEntries(
          Object.entries(registry.collections).map((
            [alias, definition],
          ) => [
            alias,
            new Proxy({
              create: (input: Record<string, unknown>, extra?: unknown) => {
                if (extra !== undefined) return unsupported();
                return transaction(({ collections }) =>
                  collections[alias].create(input)
                );
              },
              update: (
                input: Record<string, unknown> & { id: string },
                extra?: unknown,
              ) => {
                if (extra !== undefined) return unsupported();
                return transaction(({ collections }) =>
                  collections[alias].update(input)
                );
              },
              delete: (input: { id: string }, extra?: unknown) => {
                if (extra !== undefined) return unsupported();
                return transaction(({ collections }) =>
                  collections[alias].delete(input)
                );
              },
              commands: new Proxy(
                Object.fromEntries(
                  Object.keys(definition.commands ?? {}).map((
                    name,
                  ) => [
                    name,
                    (
                      input: Record<string, unknown> & { id: string },
                      extra?: unknown,
                    ) => {
                      if (extra !== undefined) return unsupported();
                      return transaction(({ collections }) =>
                        collections[alias].commands[name](input)
                      );
                    },
                  ]),
                ),
                {
                  get: (target, property) =>
                    Object.hasOwn(target, property)
                      ? Reflect.get(target, property)
                      : unsupported(),
                },
              ),
            }, {
              get: (target, property) =>
                Object.hasOwn(target, property)
                  ? Reflect.get(target, property)
                  : unsupported(),
            }),
          ]),
        );
        const context = {
          namespace: projection.namespace,
          databaseSchema: projection.databaseSchema,
          operationKey: projection.operationKey,
          identity: snapshot(projection.identity),
          resources: capabilities.resources,
          adapters: capabilities.adapters,
          actions: new Proxy(actions, {
            get: (target, property) =>
              Object.hasOwn(target, property)
                ? Reflect.get(target, property)
                : unsupported(),
          }),
          collections: new Proxy(directCollections, {
            get: (target, property) =>
              Object.hasOwn(target, property)
                ? Reflect.get(target, property)
                : unsupported(),
          }),
          vectors: unavailable(),
          content: unavailable(),
          streams: unavailable(),
          signal: exposed.signal,
          now: () => new Date(),
          transaction,
          readSnapshot: unsupported,
          signalDeferredWait: unsupported,
        } as unknown as ProcessorContext;
        try {
          try {
            await processor.handle(snapshot(projection.event), context);
          } catch (error) {
            await Promise.all(pending);
            if (hasPendingFailure && unknownOutcome(pendingFailure)) {
              throw pendingFailure;
            }
            check();
            if (unknownOutcome(error)) throw error;
            const terminal = isNonRetryableError(error) ||
              projection.attempts >= projection.maxAttempts;
            const precedingFailures = pendingFailures.length;
            if (
              capabilityFailure || !terminal ||
              !await processor.onError?.(
                error,
                snapshot(projection.event),
                context,
              )
            ) throw error;
            // onError may acknowledge precisely the known settled failure that
            // reached handle. Independent/unawaited failures and anything newly
            // raised by onError stay latched; uncertainty is never cleared.
            pendingFailures = pendingFailures.filter((failure, index) =>
              index >= precedingFailures || failure !== error
            );
            hasPendingFailure = pendingFailures.length > 0;
            pendingFailure = pendingFailures.find(unknownOutcome) ??
              pendingFailures[0];
          }
        } finally {
          registering = false;
          await Promise.all(pending);
        }
        if (hasPendingFailure) throw pendingFailure;
        check();
        if (capabilityFailure) unsupported();
        result = { status: "succeeded" };
      } catch (error) {
        if (
          unknownOutcome(error) ||
          (hasPendingFailure && unknownOutcome(pendingFailure))
        ) {
          throw hasPendingFailure && unknownOutcome(pendingFailure)
            ? pendingFailure
            : error;
        }
        result = cancelled
          ? { status: "cancelled", code: "processor_cancelled" }
          : {
            status: "failed",
            code: capabilityFailure
              ? "processor_capability_unsupported"
              : "processor_failed",
            retryable: !capabilityFailure && !isNonRetryableError(error),
          };
      } finally {
        registering = false;
        open = false;
        exposed.abort();
        await heartbeat.stop();
      }
      if (renewalFailed) throw renewalFailure;
      const ack = await port.complete(
        snapshot(ref),
        snapshot(result),
        cancelled ? {} : { signal: control.signal },
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
      await heartbeat?.stop();
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
