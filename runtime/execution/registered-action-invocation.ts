import { createRegisteredReadSnapshot } from "./snapshot-capability.ts";
import { createCollectionReadCapability } from "./collection-read-capability.ts";
import { normalizeActionNamedPreparation } from "./preparation-call.ts";
/** Ordinary Action context/invocation kernel, independent of placement.
 * This returns a safe completion proposal, never a durable terminal receipt. */
import type { PluginRegistry } from "../plugins/registry.ts";
import type { OwnerJson } from "../owner/boundary.ts";
import type { OwnerEffectPort } from "../owner/effects-client.ts";
import { createOwnerEffectClient } from "../owner/effects-client.ts";
import { createActionEffectController } from "../actions/effects.ts";
import { readExecutionRecovery } from "./recovery.ts";
import { createActionInvocationContext } from "../actions/execution-context.ts";
import { actionTransactionIdentity } from "../actions/transaction-identity.ts";
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { isActionDeferral } from "../actions/deferral.ts";
import type {
  ActionCallOptions,
  ActionContext,
  ActionReconcileResult,
  ActionTransactionOptions,
  RuntimeContext,
} from "../actions/types.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { assertJsonValue } from "../json.ts";
import { createOwnerTransactionPlanner } from "../owner/transaction.ts";

import type {
  RegisteredActionInvocation,
  RegisteredContextCapabilities,
  RegisteredExecutionCompletion,
  RegisteredInvocationCalls,
  RegisteredInvocationLifetime,
} from "./registered-invocation.ts";

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

export async function runRegisteredActionInvocation(
  options: Readonly<{
    registry: PluginRegistry;
    invocation: RegisteredActionInvocation;
    lifetime: RegisteredInvocationLifetime;
    calls: RegisteredInvocationCalls;
    effects?: OwnerEffectPort;
    createCapabilities():
      | RegisteredContextCapabilities
      | Promise<RegisteredContextCapabilities>;
  }>,
): Promise<RegisteredExecutionCompletion> {
  const { registry, createCapabilities, effects: effectPort } = options;
  const projection = snapshot(options.invocation);
  const { check, isCancelled, commandSignal, exposedSignal } = options.lifetime;
  const { execute, invokeAction } = options.calls;
  const prepareAction = options.calls.prepareAction?.bind(options.calls);
  const readCollection = options.calls.readCollection?.bind(options.calls);
  let capabilityFailure = false;
  let registrationOpen = true;
  // The bound counts calls over the whole invocation; settled calls stay here.
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
  const readSnapshot = createRegisteredReadSnapshot({
    collections: registry.collections,
    port: options.calls.snapshots,
    signal: commandSignal,
    check,
    unsupported,
    track,
  });
  const planner = createOwnerTransactionPlanner({
    collections: registry.collections,
    identity: {
      ownerId: projection.ownerId,
      invocationId: projection.invocation.actionRunId,
    },
    execute(command, executeOptions) {
      check();
      if (capabilityFailure) return unsupported();
      return execute(command, executeOptions);
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
          ? AbortSignal.any([commandSignal, transactionOptions.signal])
          : commandSignal,
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
    const executeAction = action.execute;
    const reconcile = action.reconcile;
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
    const recovery = projection.recovery === undefined
      ? undefined
      : readExecutionRecovery(projection.recovery);
    if (recovery?.status === "blocked") {
      effectIndeterminate = true;
      throw failure("effect_indeterminate");
    }
    const capabilities = await createCapabilities();
    check();
    let actionIndex = 0;
    const prepareNamed =
      (actionAlias: string) => (request: unknown, callOptions: unknown) =>
        track(() => {
          if (!prepareAction) {
            capabilityFailure = true;
            throw failure("action_prepare_unavailable");
          }
          const normalized = normalizeActionNamedPreparation(
            request,
            callOptions,
          );
          return prepareAction({
            actionAlias,
            ...normalized.request,
            operationKey: normalized.operationKey,
          }, {
            signal: normalized.signal
              ? AbortSignal.any([commandSignal, normalized.signal])
              : commandSignal,
          });
        });
    const nestedActions = new Proxy(
      Object.fromEntries(
        Object.keys(registry.actions).map((actionAlias) => [
          actionAlias,
          new Proxy(
            Object.assign(
              (input: unknown, callOptions: ActionCallOptions = {}) => {
                if (
                  !invokeAction ||
                  callOptions.identity !== undefined ||
                  callOptions.metadata !== undefined
                ) return unsupported();
                const localKey = callOptions.operationKey?.trim() ||
                  String(++actionIndex);
                identifier(localKey);
                return track(() =>
                  invokeAction({
                    actionAlias,
                    input: snapshot(input) as OwnerJson,
                    operationKey: localKey,
                  }, {
                    signal: callOptions.signal
                      ? AbortSignal.any([
                        commandSignal,
                        callOptions.signal,
                      ])
                      : commandSignal,
                  })
                );
              },
              { prepare: unsupported, prepareNamed: prepareNamed(actionAlias) },
            ),
            {
              get: (target, property) =>
                property === "prepareNamed"
                  ? Reflect.get(target, property)
                  : unsupported(),
            },
          ),
        ]),
      ),
      {
        get(target, property) {
          return Object.hasOwn(target, property)
            ? Reflect.get(target, property)
            : unsupported();
        },
      },
    );
    const absentEffect = (): never => {
      capabilityFailure = true;
      throw failure("action_effect_unavailable");
    };
    const effects = effectPort
      ? createActionEffectController({
        client: createOwnerEffectClient({
          ownerId: projection.ownerId,
          namespace: projection.namespace,
          actionRunId: projection.invocation.actionRunId,
          port: effectPort,
        }),
        signal: commandSignal,
        check,
        track,
        context: () => context,
        reconcile: reconcile as
          | ((
            step: string,
            context: ActionContext,
          ) =>
            | ActionReconcileResult
            | Promise<ActionReconcileResult>)
          | undefined,
      })
      : undefined;
    const context = createActionInvocationContext({
      effect: effects?.effect ?? {
        begin: absentEffect,
        inspect: absentEffect,
        confirm: absentEffect,
        notStarted: absentEffect,
      },
      host: {
        namespace: projection.namespace,
        databaseSchema: projection.databaseSchema,
        resources: capabilities.resources,
        adapters: capabilities.adapters,
        collections: new Proxy(
          Object.fromEntries(
            Object.keys(registry.collections).map((alias) => [
              alias,
              new Proxy(
                createCollectionReadCapability({
                  alias,
                  read: readCollection,
                  signal: commandSignal,
                  check,
                  unsupported,
                  track,
                }),
                {
                  get: (target, key) =>
                    Object.hasOwn(target, key)
                      ? Reflect.get(target, key)
                      : unsupported(),
                },
              ),
            ]),
          ),
          {
            get: (target, key) =>
              Object.hasOwn(target, key)
                ? Reflect.get(target, key)
                : unsupported(),
          },
        ),
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
        signal: exposedSignal,
        now: () => new Date(),
        transaction,
        readSnapshot: readSnapshot as RuntimeContext["readSnapshot"],
        signalDeferredWait: unsupported,
      } as unknown as RuntimeContext,
      frame: {
        ...snapshot(projection.invocation),
        actionId: projection.actionId,
        signal: exposedSignal,
        nextActionIndex: unsupported,
      },
      actions: nestedActions,
      progress: unsupported,
      registerDeferredWait: unsupported,
    });
    let output: unknown;
    try {
      for (const item of recovery?.effects ?? []) {
        if (item.status !== "begun") continue;
        if (!effects) {
          effectIndeterminate = true;
          throw failure("effect_indeterminate");
        }
        await effects.recover(item.step);
      }
      // A caught/unawaited reconciliation failure cannot reopen execution.
      await Promise.all(pending);
      if (hasPendingFailure) throw pendingFailure;
      check();
      output = await (executeAction as (
        input: unknown,
        context: ActionContext,
      ) => unknown).call(action, snapshot(projection.input), context);
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
    completion = isCancelled()
      ? { status: "cancelled", code: "action_cancelled" }
      : {
        status: "failed",
        code: capabilityFailure
          ? "action_capability_unsupported"
          : effectIndeterminate ||
              (error !== null && typeof error === "object" &&
                "code" in error && error.code === "effect_indeterminate")
          ? "effect_indeterminate"
          : "action_failed",
      };
  } finally {
    registrationOpen = false;
  }
  return completion;
}
