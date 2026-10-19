import { wrapEffectConfirmation } from "./effect-client.ts";
import { isOwnerExecutionInterrupted } from "../execution/owner-interruption.ts";
import {
  closeCollectionPolicyInvocation,
  preserveCollectionInvocation,
} from "../authorization/invocation.ts";
import {
  isOwnerAuthorizationRefusal,
  sanitizedAuthorizationRefusal,
} from "../engine/authorization-refusal.ts";
import { callerDefinition, recordActionCaller } from "./caller-identity.ts";
import { withOwnerCommandAuthorization } from "../engine/command-authorization.ts";
import { authorizeActionCapabilities } from "./capability-authorization.ts";
import { createActionEffectController } from "./effects.ts";
import {
  type ActionEffectClient,
  fail as effectFailure,
} from "./effect-client.ts";
import {
  awaitingAction,
  isActionContinuation,
  type OperationOutcome,
} from "./continuation.ts";
import {
  actionContentDeclaration,
  durableActionContentInput,
  prepareActionContentInput,
} from "./content.ts";
import type { RuntimeContent } from "./types.ts";
import {
  isJsonSchemaValidationError,
  validateAgainstJsonSchema,
} from "../collections/validate.ts";
import { markNonRetryable } from "../failure.ts";
import { ActionError } from "./errors.ts";
import {
  durableActionMetadata,
  durableActionValue,
  sameActionValue,
} from "./value.ts";
import type {
  ActionCallers,
  ActionCallOptions,
  ActionContext,
  ActionInvocationMetadata,
  ActionMap,
  ActionPrepareFactory,
  ActionPrepareOptions,
  AnyActionDefinition,
  BoundActionCaller,
  RuntimeActionCallers,
  RuntimeIdentity,
} from "./types.ts";
import { actionDefinitionHasSecrets } from "./protected-lifecycle.ts";
import {
  assertMetadataIsSecretFree,
  protectedActionStrings,
  splitSecretActionValue,
} from "./secret.ts";
import type {
  ActionAwaitingData,
  ActionEventData,
  ActionInvokedData,
  ActionLifecycleEmitter,
  SerializedActionError,
} from "./types.ts";

const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const settledActionErrors = new WeakSet<object>();
const actionInputValidationErrors = new WeakSet<object>();
// A composed Action alias is presentation only: Core needs the immutable
// definition identity behind a caller when it persists a continuation.
// Keep that association private to the runtime rather than widening every
// caller's public callable shape.

/**
 * Identifies a caller value that failed an Action's input schema before an
 * invocation lifecycle began. Orchestrators may turn this into a semantic
 * failure while unrelated preflight and infrastructure errors still surface.
 */
export type ActionInputValidationError =
  & TypeError
  & Readonly<{ actionId: string }>;

function actionInputValidationError(
  actionId: string,
  cause: TypeError,
): ActionInputValidationError {
  const error = markNonRetryable(new TypeError(cause.message, { cause }));
  error.name = "ActionInputValidationError";
  Object.defineProperty(error, "actionId", {
    value: actionId,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  actionInputValidationErrors.add(error);
  return error as unknown as ActionInputValidationError;
}

/** True only for pre-lifecycle Action input-schema failures. */
export function isActionInputValidationError(
  error: unknown,
): error is ActionInputValidationError {
  return error instanceof TypeError && actionInputValidationErrors.has(error);
}

/** Returns the registered Action definition id for a composed caller. */
export function actionCallerDefinitionId(value: unknown): string | undefined {
  return callerDefinition(value);
}

export type ActionInvocationFrame = Readonly<{
  actionId: string;
  actionRunId: string;
  rootKey: string;
  operationKey: string;
  parentActionRunId?: string;
  metadata: ActionInvocationMetadata;
  identity?: RuntimeIdentity;
  signal: AbortSignal;
  nextActionIndex(): number;
}>;

export type CreateActionCallersOptions = Readonly<{
  actionLifecycle: ActionLifecycleEmitter;
  /** Current owner policy for input, mutations and result disclosure. */
  authorize?(
    frame: ActionInvocationFrame,
    purpose: "input" | "mutation" | "result",
    transaction?: import("../events/session.ts").SqlExecutor,
  ): Promise<void>;
  /** Private owner-only cleanup; never accepts worker error/status/output. */
  refuseAuthorization?(
    frame: ActionInvocationFrame,
  ): Promise<{ error: Error; settled: boolean }>;
  /** Owner-only preparation; no worker-callable hook. */
  prepareInput?(
    frame: ActionInvocationFrame,
    input: unknown,
  ):
    | Promise<
      | {
        input: unknown;
        claimed: boolean;
        metadata?: ActionInvocationMetadata;
      }
      | undefined
    >
    | undefined;
  /** Runtime-only resumption delivery; never exposed through ActionCallOptions. */
  resumption?: Readonly<
    {
      receipt: ActionAwaitingData;
      outcome: OperationOutcome;
      causationId?: string;
    }
  >;
  content?: RuntimeContent;
  /** Root prefix; explicit keys must not depend on call ordering. */
  createInvocationKey?: (actionId: string, operationKey?: string) => string;
  /** Stable root scope for awaiting Action captures in one processor run. */
  invocationScope?: string;
  identity?: RuntimeIdentity;
  signal: AbortSignal;
  /** Invocation-bound data capability, supplied only by the owner host. */
  createEffectClient?(frame: ActionInvocationFrame): ActionEffectClient;
  createContext(
    input: Readonly<{
      frame: ActionInvocationFrame;
      actions: RuntimeActionCallers;
      progress(value: unknown): Promise<void>;
    }>,
  ): ActionContext;
}>;

function requireAlias(alias: string): string {
  const value = alias.trim();
  if (!ALIAS_PATTERN.test(value)) {
    throw new TypeError(`Action has invalid alias '${alias}'.`);
  }
  return value;
}

function mergeSignal(
  parent: AbortSignal,
  child: AbortSignal | undefined,
): AbortSignal {
  if (!child || child === parent) return parent;
  return AbortSignal.any([parent, child]);
}

function mergeIdentity(
  parent: RuntimeIdentity | undefined,
  child: RuntimeIdentity | undefined,
): RuntimeIdentity | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return ({
    causationId: child.causationId ?? parent.causationId,
    correlationId: child.correlationId ?? parent.correlationId,
    deduplicationId: child.deduplicationId ?? parent.deduplicationId,
    settlementScopeId: child.settlementScopeId ?? parent.settlementScopeId,
    actionScopeId: child.actionScopeId ?? parent.actionScopeId,
  } as const);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("This operation was aborted.", "AbortError");
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeError(
  error: unknown,
  protectedStrings: readonly string[] = [],
): SerializedActionError {
  const redact = (value: string): string => {
    let result = value;
    for (const secret of protectedStrings) {
      if (secret) result = result.split(secret).join("[redacted]");
    }
    return result;
  };
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return ({
      name: redact(error.name || "Error"),
      message: redact(error.message || error.name || "Action failed."),
      ...(typeof code === "string" && code.trim()
        ? { code: redact(code) }
        : {}),
      ...(error instanceof ActionError
        ? { callerSafe: true as const, status: error.status }
        : {}),
    } as const);
  }
  return ({ name: "Error", message: redact(String(error)) } as const);
}

function protectedActionError(
  cancelled: boolean,
): SerializedActionError {
  return ({
    name: cancelled ? "AbortError" : "Error",
    message: cancelled
      ? "Action execution was cancelled."
      : "Action execution failed.",
  } as const);
}

function restoredActionError(
  status: "failed" | "cancelled",
  serialized: SerializedActionError,
): Error {
  const error = serialized.callerSafe
    ? new ActionError(serialized.message, {
      code: serialized.code!,
      status: serialized.status,
    })
    : new Error(serialized.message);
  error.name = status === "cancelled" ? "AbortError" : serialized.name;
  if (serialized.code !== undefined) {
    Object.assign(error, { code: serialized.code });
  }
  if (
    serialized.name === "ActionEffectError" ||
    serialized.code === "owner_commit_unknown"
  ) {
    markNonRetryable(error);
  }
  return error;
}

function settledActionError(error: unknown): unknown {
  const value = ((typeof error === "object" && error !== null) ||
      typeof error === "function")
    ? error as object
    : new Error(String(error), { cause: error });
  settledActionErrors.add(value);
  return value;
}

/** True only after the Action terminal lifecycle Event is durable. */
export function isSettledActionError(error: unknown): boolean {
  return ((typeof error === "object" && error !== null) ||
    typeof error === "function") && settledActionErrors.has(error as object);
}

function createFrame(
  action: AnyActionDefinition,
  options: ActionCallOptions,
  parent: ActionInvocationFrame | undefined,
  invoker: CreateActionCallersOptions,
  prepared = false,
): ActionInvocationFrame {
  const resumption =
    !parent && invoker.resumption?.receipt.actionId === action.id
      ? invoker.resumption
      : undefined;
  const metadata = durableActionMetadata(
    resumption?.receipt.metadata ?? options.metadata ?? {},
  );
  const explicitKey = options.operationKey?.trim() || undefined;
  const inheritedIdentity = mergeIdentity(
    parent?.identity ?? invoker.identity,
    options.identity,
  );
  const identity = resumption
    ? { ...inheritedIdentity, causationId: resumption.causationId }
    : inheritedIdentity;
  const signal = mergeSignal(parent?.signal ?? invoker.signal, options.signal);
  const hostInvocationKey = parent || prepared
    ? undefined
    : invoker.createInvocationKey?.(action.id, explicitKey)?.trim() ||
      undefined;
  // Root prepared calls replay a durable capture, so neither their stable
  // operation key nor their lifecycle identity may depend on a host callback.
  // Lifecycle storage already isolates the fallback scope by namespace.
  const preparedInvocationScope = prepared
    ? invoker.invocationScope?.trim() || "lifecycle"
    : undefined;
  const identityInvocationKey = parent || prepared
    ? undefined
    : identity?.deduplicationId?.trim() || undefined;
  const rootKey = parent?.rootKey ?? preparedInvocationScope ??
    hostInvocationKey ??
    identityInvocationKey ?? explicitKey ?? `invocation:${crypto.randomUUID()}`;
  const localKey = explicitKey ?? String(parent?.nextActionIndex() ?? 1);
  const actionRunId = resumption?.receipt.actionRunId ??
    (parent
      ? `${parent.operationKey}/action:${action.id}:${localKey}`
      : preparedInvocationScope
      ? explicitKey
        ? `${preparedInvocationScope}:action:${action.id}:${explicitKey}`
        : `${preparedInvocationScope}:action:${action.id}`
      : hostInvocationKey
      ? explicitKey ? `${hostInvocationKey}:${explicitKey}` : hostInvocationKey
      : identityInvocationKey
      ? `${rootKey}/action:${action.id}:${localKey}`
      : `${rootKey}/action:${action.id}`);
  let actionIndex = 0;
  return {
    actionId: action.id,
    actionRunId,
    rootKey,
    operationKey: resumption ? `${actionRunId}/resume` : actionRunId,
    ...(parent
      ? { parentActionRunId: parent.actionRunId }
      : resumption?.receipt.parentActionRunId
      ? { parentActionRunId: resumption.receipt.parentActionRunId }
      : {}),
    metadata,
    ...(identity ? { identity } : {}),
    signal,
    nextActionIndex: () => ++actionIndex,
  } as const;
}

function lifecycleCommon(
  frame: ActionInvocationFrame,
  input: unknown,
) {
  return {
    actionRunId: frame.actionRunId,
    actionId: frame.actionId,
    ...(frame.parentActionRunId
      ? { parentActionRunId: frame.parentActionRunId }
      : {}),
    metadata: frame.metadata,
    actionScopeId: frame.identity?.actionScopeId,
    input,
    ...(frame.identity?.causationId
      ? { causationId: frame.identity.causationId }
      : {}),
    ...(frame.identity?.correlationId
      ? { correlationId: frame.identity.correlationId }
      : {}),
    ...(frame.identity?.settlementScopeId
      ? { settlementScopeId: frame.identity.settlementScopeId }
      : {}),
  } as const;
}

async function loadTerminal(
  lifecycle: ActionLifecycleEmitter,
  frame: ActionInvocationFrame,
  input: unknown,
): Promise<ActionEventData | null> {
  const terminal = await lifecycle.terminal(frame.actionRunId);
  if (!terminal) return null;
  validateReceipt(terminal, frame, input);
  return terminal;
}

function validateReceipt(
  receipt: ActionEventData,
  frame: ActionInvocationFrame,
  input: unknown,
): void {
  if (receipt.actionId !== frame.actionId) {
    throw new Error(
      `Action run '${frame.actionRunId}' belongs to '${receipt.actionId}', not '${frame.actionId}'.`,
    );
  }
  if (receipt.parentActionRunId !== frame.parentActionRunId) {
    throw new Error(
      `Action run '${frame.actionRunId}' was retried with a different parent.`,
    );
  }
  if (!sameActionValue(receipt.input, input)) {
    throw new Error(
      `Action run '${frame.actionRunId}' was retried with different input.`,
    );
  }
  if (!sameActionValue(receipt.metadata, frame.metadata)) {
    throw new Error(
      `Action run '${frame.actionRunId}' was retried with different metadata.`,
    );
  }
}

function validateReceiptIdentity(
  receipt: ActionEventData,
  frame: ActionInvocationFrame,
): void {
  if (receipt.actionId !== frame.actionId) {
    throw new Error(
      `Action run '${frame.actionRunId}' belongs to '${receipt.actionId}', not '${frame.actionId}'.`,
    );
  }
  if (receipt.parentActionRunId !== frame.parentActionRunId) {
    throw new Error(
      `Action run '${frame.actionRunId}' was retried with a different parent.`,
    );
  }
}

async function loadInvoked(
  lifecycle: ActionLifecycleEmitter,
  frame: ActionInvocationFrame,
  input: unknown,
): Promise<ActionInvokedData | null> {
  const invoked = await lifecycle.invoked(frame.actionRunId);
  if (!invoked) return null;
  validateReceipt(invoked, frame, input);
  return invoked;
}

function restoreTerminal(terminal: ActionEventData): unknown {
  if (terminal.status === "completed") {
    return structuredClone(terminal.output);
  }
  if (terminal.status === "failed" || terminal.status === "cancelled") {
    throw settledActionError(
      restoredActionError(terminal.status, terminal.error),
    );
  }
  throw new Error(`Action terminal lookup returned '${terminal.status}'.`);
}

function actionCaller(
  action: AnyActionDefinition,
  actions: ActionMap,
  invoker: CreateActionCallersOptions,
  parent?: ActionInvocationFrame,
): BoundActionCaller<AnyActionDefinition> {
  const authorize = invoker.authorize;
  type Invocation = {
    frame: ActionInvocationFrame;
    refusal?: unknown;
    remember(error: unknown): void;
  };
  const invokeBody = async (
    input: unknown,
    options: ActionCallOptions = {},
    captureRace = false,
    prepared = false,
    invocation: Invocation,
  ): Promise<unknown> => {
    const frame = invocation.frame;
    throwIfAborted(frame.signal);
    const lifecycle = authorize
      ? {
        ...invoker.actionLifecycle,
        emit: ((input) =>
          withOwnerCommandAuthorization(
            (command, purpose) =>
              authorize!(frame, purpose, command.transaction),
            () => invoker.actionLifecycle.emit(input),
          )) as ActionLifecycleEmitter["emit"],
      }
      : invoker.actionLifecycle;
    const ownerPrepared = await invoker.prepareInput?.(frame, input);
    if (ownerPrepared) {
      input = ownerPrepared.input;
      if (ownerPrepared.metadata) {
        Object.assign(frame, { metadata: ownerPrepared.metadata });
      }
    }
    await authorize?.(frame, "input");

    // Execution receives the canonical value; lifecycle persistence applies
    // the schema-owned protected projection inside its storage boundary.
    if (
      action.content && (!invoker.content || actionDefinitionHasSecrets(action))
    ) {
      throw new TypeError(
        "Action content requires runtime content services and non-secret schemas.",
      );
    }
    // A recorded result remains replayable after its input content is collected.
    // Only an attempt that still needs execution must open the captured pointers.
    if (action.content) {
      const terminal = await lifecycle.terminal(
        frame.actionRunId,
      );
      if (terminal) {
        if (captureRace) validateReceiptIdentity(terminal, frame);
        else {
          validateReceipt(
            terminal,
            frame,
            durableActionContentInput(input, action.content),
          );
        }
        await authorize?.(frame, "result");
        return restoreTerminal(terminal);
      }
    }
    const preparedContent = action.content
      ? await prepareActionContentInput(
        input,
        actionContentDeclaration(action.content),
        invoker.content!,
        frame.signal,
      )
      : undefined;
    const durableInput = preparedContent?.durableInput ??
      durableActionValue(input);
    const validateInput = (value: unknown) => {
      if (!action.inputSchema) return;
      try {
        validateAgainstJsonSchema(
          action.inputSchema,
          value,
          `Action '${action.id}' input`,
        );
      } catch (error) {
        if (isJsonSchemaValidationError(error)) {
          throw actionInputValidationError(action.id, error);
        }
        throw error;
      }
    };
    if (!preparedContent) validateInput(durableInput);
    const inputSecrets = protectedActionStrings(
      action.inputSchema,
      durableInput,
    );
    assertMetadataIsSecretFree(frame.metadata, inputSecrets);
    const executionInput = preparedContent
      ? await preparedContent.hydrate()
      : durableInput;
    if (preparedContent) validateInput(executionInput);
    throwIfAborted(frame.signal);

    // The invoked receipt is the claim on this run: its deduplication id is
    // unique, so inserting it either wins the run or reports an earlier
    // receipt. Only then are the receipts read, and a run seen for the first
    // time reads nothing.
    const resumption =
      !parent && invoker.resumption?.receipt.actionRunId === frame.actionRunId
        ? invoker.resumption
        : undefined;
    if (resumption) {
      validateReceipt(resumption.receipt, frame, durableInput);
      const terminal = await loadTerminal(
        lifecycle,
        frame,
        durableInput,
      );
      if (terminal) {
        await authorize?.(frame, "result");
        return restoreTerminal(terminal);
      }
    }
    let replayProtocol: number | undefined = resumption
      ? (await loadInvoked(lifecycle, frame, durableInput))
        ?.effectProtocol
      : 1;
    let claimError: unknown;
    let claimed = Boolean(resumption) || (ownerPrepared?.claimed ?? false);
    try {
      if (!resumption && !ownerPrepared) {
        const receipt = await lifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status: "invoked",
          effectProtocol: 1,
          deduplicationId: `${frame.actionRunId}:action:invoked`,
        });
        claimed =
          (receipt as { deduplicated?: unknown } | undefined)?.deduplicated ===
            false;
      }
    } catch (error) {
      claimError = error;
    }
    if (!claimed) {
      const existing = captureRace
        ? await lifecycle.terminal(frame.actionRunId)
        : await loadTerminal(lifecycle, frame, durableInput);
      if (existing && captureRace) {
        validateReceiptIdentity(existing, frame);
        return await invoke(
          existing.input,
          {
            ...options,
            metadata: existing.metadata,
          },
          false,
          prepared,
        );
      }
      if (existing) {
        await authorize?.(frame, "result");
        return restoreTerminal(existing);
      }

      const invoked = captureRace
        ? await lifecycle.invoked(frame.actionRunId)
        : await loadInvoked(lifecycle, frame, durableInput);
      if (invoked && captureRace) {
        validateReceiptIdentity(invoked, frame);
        return await invoke(
          invoked.input,
          {
            ...options,
            metadata: invoked.metadata,
          },
          false,
          prepared,
        );
      }
      if (!invoked && claimError !== undefined) throw claimError;
      const awaiting = await lifecycle.awaiting?.(
        frame.actionRunId,
      );
      if (awaiting) {
        validateReceipt(awaiting, frame, durableInput);
        return awaitingAction(frame.actionRunId);
      }
      replayProtocol = invoked?.effectProtocol;
      // A receipt permits replay only when the current lease still owns the Action.
      if (claimError !== undefined) throw claimError;
    }

    let progressIndex = resumption?.receipt.progressIndex ?? 0;
    let progressTail: Promise<void> = Promise.resolve();
    const progress = (value: unknown): Promise<void> => {
      if (actionDefinitionHasSecrets(action)) {
        return Promise.reject(
          new TypeError(
            `Action '${action.id}' cannot persist progress while it declares secret input or output; progressSchema is not supported.`,
          ),
        );
      }
      const index = ++progressIndex;
      const durableProgress = durableActionValue(value);
      progressTail = progressTail.then(async () => {
        await lifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status: "progress",
          progress: durableProgress,
          progressIndex: index,
          deduplicationId: `${frame.actionRunId}:action:progress:${index}`,
        });
      });
      return progressTail;
    };
    const nestedActions = createActionCallers(
      actions,
      invoker,
      frame,
    ) as RuntimeActionCallers;
    let context = invoker.createContext({
      frame,
      actions: nestedActions,
      progress,
    });

    const collectionPolicyContext = context;
    const rawClient = invoker.createEffectClient?.(frame);
    const client = rawClient && {
      ...rawClient,
      confirm: wrapEffectConfirmation(rawClient.confirm, (confirm) =>
      (
        step: string,
        outcome: Parameters<ActionEffectClient["confirm"]>[1],
        callOptions?: Parameters<ActionEffectClient["confirm"]>[2],
      ) => {
        assertMetadataIsSecretFree({ outcome }, inputSecrets);
        if (splitSecretActionValue(action.outputSchema, outcome).secret) {
          effectFailure(
            "effect_outcome_invalid",
            "Protected effect outcomes must use safe references.",
          );
        }
        return confirm(step, outcome, callOptions);
      }),
    };
    const pendingEffects = new Set<Promise<unknown>>();
    const pendingCapabilityCleanup = new Set<Promise<void>>();
    let effectError: unknown;
    let closed = false;
    const controller = client && createActionEffectController({
      client,
      signal: frame.signal,
      check() {
        if (closed) {
          effectFailure("ActionOwnershipLost", "The Action attempt has ended.");
        }
        frame.signal.throwIfAborted();
      },
      context: () => context,
      reconcile: action.reconcile as never,
      track(start) {
        const pending = Promise.resolve().then(start);
        pendingEffects.add(pending);
        void pending.then(() => pendingEffects.delete(pending), (error) => {
          pendingEffects.delete(pending);
          effectError ??= error;
        });
        return pending;
      },
    });
    if (controller) {
      // Preserve nonenumerable host capabilities (including source resolution).
      context = preserveCollectionInvocation(
        Object.defineProperties({}, {
          ...Object.getOwnPropertyDescriptors(context),
          effect: { value: controller.effect, enumerable: true },
        }) as ActionContext,
        context,
      );
    }
    {
      context = preserveCollectionInvocation(
        authorizeActionCapabilities(
          context,
          authorize
            ? (command, purpose) =>
              authorize(frame, purpose, command.transaction)
            : undefined,
          () => {
            if (closed) {
              throw new Error("Action capability lifetime has ended.");
            }
            frame.signal.throwIfAborted();
          },
          invocation.remember,
          authorize ? () => authorize(frame, "result") : undefined,
          (pending) => {
            pendingCapabilityCleanup.add(pending);
            void pending.finally(() =>
              pendingCapabilityCleanup.delete(pending)
            );
          },
        ),
        context,
      );
    }
    const drainEffects = async () => {
      while (pendingEffects.size) await Promise.allSettled([...pendingEffects]);
      if (effectError) throw effectError;
    };
    try {
      throwIfAborted(frame.signal);
      if (replayProtocol !== 1) {
        effectFailure(
          "effect_indeterminate",
          "The original Action attempt did not capture the effect replay contract.",
        );
      }
      // Reconcile before re-entering user code, including effects a new deployment
      // no longer mentions. An empty current inventory cannot upgrade an old run.
      if ((!claimed || resumption) && client && controller) {
        for (const entry of await client.inventory()) {
          if (entry.status === "begun") {
            await controller.recover(entry.step);
          }
        }
      }
      const output = resumption
        ? await action.resume!(
          resumption.receipt.handoff as never,
          resumption.outcome as never,
          context as never,
        )
        : await action.execute(executionInput as never, context as never);
      if (invocation.refusal) throw invocation.refusal;
      await progressTail;
      await drainEffects();
      throwIfAborted(frame.signal);
      if (isActionContinuation(output)) {
        if (!action.resume) {
          throw new TypeError("An Action continuation requires resume.");
        }
        if (resumption) {
          throw new TypeError("A resumption must produce a terminal result.");
        }
        assertMetadataIsSecretFree({
          handoff: output.handoff,
          ...(output.start
            ? {
              start: {
                ...output.start,
                input: splitSecretActionValue(
                  actions[output.start.action]?.inputSchema,
                  output.start.input,
                ).publicValue,
              },
            }
            : { operationId: output.operationId }),
        }, inputSecrets);
        await lifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status: "awaiting",
          handoff: output.handoff,
          ...(output.start
            ? { start: output.start }
            : { operationId: output.operationId }),
          progressIndex,
          deduplicationId: `${frame.actionRunId}:action:awaiting`,
        });
        return awaitingAction(frame.actionRunId);
      }
      if (action.outputSchema) {
        validateAgainstJsonSchema(
          action.outputSchema,
          output,
          `Action '${action.id}' output`,
        );
      }
      const durableOutput = durableActionValue(output);
      try {
        await lifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status: "completed",
          output: durableOutput,
          deduplicationId: `${frame.actionRunId}:action:terminal`,
        });
      } catch (error) {
        const terminal = captureRace
          ? await lifecycle.terminal(frame.actionRunId)
          : await loadTerminal(lifecycle, frame, durableInput);
        if (terminal && captureRace) validateReceiptIdentity(terminal, frame);
        if (terminal) {
          await authorize?.(frame, "result");
          return restoreTerminal(terminal);
        }
        throw error;
      }
      await authorize?.(frame, "result");
      return structuredClone(durableOutput);
    } catch (caught) {
      if (isOwnerAuthorizationRefusal(caught) || invocation.refusal) {
        throw invocation.refusal ?? caught;
      }
      await Promise.allSettled([...pendingEffects]);
      let error = effectError ?? caught;
      // A provider exception after dispatch proves neither success nor no-start.
      // Preserve ambiguity in this Action's failure terminal.
      if (client) {
        try {
          if (
            (await client.inventory()).some((entry) => entry.status === "begun")
          ) {
            effectFailure(
              "effect_indeterminate",
              "An external effect has no confirmed outcome.",
            );
          }
        } catch (classification) {
          error = classification;
        }
      }
      const existingTerminal = captureRace
        ? await lifecycle.terminal(frame.actionRunId)
        : await loadTerminal(lifecycle, frame, durableInput);
      if (existingTerminal && captureRace) {
        validateReceiptIdentity(existingTerminal, frame);
      }
      if (existingTerminal) {
        await authorize?.(frame, "result");
        return restoreTerminal(existingTerminal);
      }
      // Physical placement loss is not an Action business terminal. A later
      // owner-authorized attempt must reconcile the durable effect inventory
      // before user code can run again. Accepted terminals above still win.
      if (isOwnerExecutionInterrupted(caught)) throw caught;
      const status = frame.signal?.aborted || isCancellationError(error)
        ? "cancelled" as const
        : "failed" as const;
      try {
        await lifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status,
          error: actionDefinitionHasSecrets(action)
            ? protectedActionError(status === "cancelled")
            : safeError(error, inputSecrets),
          deduplicationId: `${frame.actionRunId}:action:terminal`,
        });
      } catch (settlementError) {
        const terminal = captureRace
          ? await lifecycle.terminal(frame.actionRunId)
          : await loadTerminal(lifecycle, frame, durableInput);
        if (terminal && captureRace) validateReceiptIdentity(terminal, frame);
        if (terminal) {
          await authorize?.(frame, "result");
          return restoreTerminal(terminal);
        }
        throw settlementError;
      }
      throw settledActionError(error);
    } finally {
      closed = true;
      // Revocation may return a logical refusal before a native read resource
      // acknowledges cancellation. Keep this invocation physically occupied.
      while (pendingCapabilityCleanup.size) {
        await Promise.allSettled([...pendingCapabilityCleanup]);
      }
      closeCollectionPolicyInvocation(collectionPolicyContext);
    }
  };
  const invoke = async (
    input: unknown,
    options: ActionCallOptions = {},
    captureRace = false,
    prepared = false,
  ): Promise<unknown> => {
    const cancellation = new AbortController();
    const frame = createFrame(
      action,
      {
        ...options,
        signal: mergeSignal(
          options.signal ?? invoker.signal,
          cancellation.signal,
        ),
      },
      parent,
      invoker,
      prepared,
    );
    const invocation: Invocation = {
      frame,
      remember(error) {
        if (isOwnerAuthorizationRefusal(error)) {
          invocation.refusal ??= error;
          cancellation.abort(sanitizedAuthorizationRefusal());
        }
      },
    };
    try {
      return await invokeBody(
        input,
        options,
        captureRace,
        prepared,
        invocation,
      );
    } catch (caught) {
      let error = invocation.refusal ?? caught;
      if (isOwnerAuthorizationRefusal(error) && invoker.refuseAuthorization) {
        const refusal = await invoker.refuseAuthorization(frame);
        error = refusal.settled
          ? settledActionError(refusal.error)
          : refusal.error;
      }
      throw error;
    }
  };
  const caller = Object.assign((...args: [unknown, ActionCallOptions?]) => {
    if (args.length > 2) {
      throw new TypeError("Action calls accept input and options only.");
    }
    return invoke(args[0], args[1]);
  }, {
    async prepare(
      factory: ActionPrepareFactory<unknown>,
      options: ActionPrepareOptions,
    ): Promise<unknown> {
      if (
        typeof options?.operationKey !== "string" ||
        !options.operationKey.trim()
      ) {
        throw new TypeError("Prepared Action operationKey must be non-empty.");
      }
      const bootstrap = createFrame(action, options, parent, invoker, true);
      const restore = async (receipt: ActionEventData): Promise<unknown> => {
        validateReceiptIdentity(receipt, bootstrap);
        return await invoke(
          receipt.input,
          {
            ...options,
            metadata: receipt.metadata,
          },
          false,
          true,
        );
      };
      throwIfAborted(bootstrap.signal);
      const terminal = await invoker.actionLifecycle.terminal(
        bootstrap.actionRunId,
      );
      if (terminal) return await restore(terminal);
      const invoked = await invoker.actionLifecycle.invoked(
        bootstrap.actionRunId,
      );
      if (invoked) return await restore(invoked);

      const prepared = await factory();
      if (
        !prepared || typeof prepared !== "object" ||
        !Object.hasOwn(prepared, "input")
      ) {
        throw new TypeError("Action prepare factory must return an input.");
      }
      throwIfAborted(bootstrap.signal);
      // A receipt may have won while preparation was in progress. The call
      // claims the run before it reads anything, so a winner is found there and
      // replayed; freshly selected history is never compared to its capture.
      return await invoke(
        prepared.input,
        {
          ...options,
          metadata: prepared.metadata,
        },
        true,
        true,
      );
    },
  });
  return caller as BoundActionCaller<AnyActionDefinition>;
}

/** Builds the single direct Action API from the composed Action alias map. */
export function createActionCallers<const TActions extends ActionMap>(
  actions: TActions,
  options: CreateActionCallersOptions,
  parent?: ActionInvocationFrame,
): ActionCallers<TActions> {
  const entries = Object.entries(actions).map(([rawAlias, action]) => {
    const caller = actionCaller(action, actions, options, parent);
    recordActionCaller(caller as object, action.id);
    return [requireAlias(rawAlias), caller] as const;
  });
  return (Object.fromEntries(entries)) as ActionCallers<TActions>;
}
