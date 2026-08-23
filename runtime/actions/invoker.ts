import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { durableActionValue, sameActionValue } from "./value.ts";
import type {
  ActionCallers,
  ActionCallOptions,
  ActionContext,
  ActionIdentity,
  ActionMap,
  ActionTransactionOptions,
  AnyActionDefinition,
} from "./types.ts";
import type {
  ActionEventData,
  ActionLifecycleEmitter,
  SerializedActionError,
} from "./types.ts";

const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const settledActionErrors = new WeakSet<object>();

export type ActionInvocationFrame = Readonly<{
  actionId: string;
  actionRunId: string;
  rootKey: string;
  operationKey: string;
  parentActionRunId?: string;
  identity?: ActionIdentity;
  signal?: AbortSignal;
  nextActionIndex(): number;
}>;

export type CreateActionCallersOptions = Readonly<{
  actionLifecycle: ActionLifecycleEmitter;
  createInvocationKey?: (actionId: string) => string;
  identity?: ActionIdentity;
  createContext(
    input: Readonly<{
      frame: ActionInvocationFrame;
      actions: Readonly<
        Record<
          string,
          (input: unknown, options?: ActionCallOptions) => Promise<unknown>
        >
      >;
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
  parent: AbortSignal | undefined,
  child: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!parent) return child;
  if (!child || child === parent) return parent;
  return AbortSignal.any([parent, child]);
}

function mergeIdentity(
  parent: ActionIdentity | undefined,
  child: ActionIdentity | undefined,
): ActionIdentity | undefined {
  if (!parent) return child;
  if (!child) return parent;
  return Object.freeze({
    causationId: child.causationId ?? parent.causationId,
    correlationId: child.correlationId ?? parent.correlationId,
    deduplicationId: child.deduplicationId ?? parent.deduplicationId,
    settlementScopeId: child.settlementScopeId ?? parent.settlementScopeId,
  });
}

/**
 * Carries causal authority into an Action-owned graph transaction. The
 * transaction keeps its own operation-derived deduplication identity unless
 * the Action explicitly supplies one for that transaction.
 */
export function actionTransactionIdentity(
  action: ActionIdentity | undefined,
  transaction: ActionTransactionOptions["identity"],
): ActionTransactionOptions["identity"] {
  const causationId = transaction?.causationId ?? action?.causationId;
  const correlationId = transaction?.correlationId ?? action?.correlationId;
  const settlementScopeId = transaction?.settlementScopeId ??
    action?.settlementScopeId;
  const deduplicationId = transaction?.deduplicationId;
  const metadata = transaction?.metadata;
  if (
    !causationId && !correlationId && !settlementScopeId &&
    !deduplicationId && !metadata
  ) return undefined;
  return Object.freeze({
    ...(causationId ? { causationId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(deduplicationId ? { deduplicationId } : {}),
    ...(settlementScopeId ? { settlementScopeId } : {}),
    ...(metadata ? { metadata } : {}),
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("This operation was aborted.", "AbortError");
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function safeError(error: unknown): SerializedActionError {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name || "Error",
      message: error.message || error.name || "Action failed.",
    });
  }
  return Object.freeze({ name: "Error", message: String(error) });
}

function restoredActionError(
  status: "failed" | "cancelled",
  serialized: SerializedActionError,
): Error {
  const error = new Error(serialized.message);
  error.name = status === "cancelled" ? "AbortError" : serialized.name;
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
): ActionInvocationFrame {
  const explicitKey = options.operationKey?.trim() || undefined;
  const identity = mergeIdentity(
    parent?.identity ?? invoker.identity,
    options.identity,
  );
  const signal = mergeSignal(parent?.signal, options.signal);
  const hostInvocationKey = parent
    ? undefined
    : invoker.createInvocationKey?.(action.id)?.trim() || undefined;
  const identityInvocationKey = parent
    ? undefined
    : identity?.deduplicationId?.trim() || undefined;
  const rootKey = parent?.rootKey ?? hostInvocationKey ??
    identityInvocationKey ?? explicitKey ?? `invocation:${crypto.randomUUID()}`;
  const localKey = explicitKey ?? String(parent?.nextActionIndex() ?? 1);
  const actionRunId = parent
    ? `${parent.actionRunId}/action:${action.id}:${localKey}`
    : hostInvocationKey
    ? explicitKey ? `${hostInvocationKey}:${explicitKey}` : hostInvocationKey
    : identityInvocationKey
    ? `${rootKey}/action:${action.id}:${localKey}`
    : `${rootKey}/action:${action.id}`;
  let actionIndex = 0;
  return Object.freeze({
    actionId: action.id,
    actionRunId,
    rootKey,
    operationKey: actionRunId,
    ...(parent ? { parentActionRunId: parent.actionRunId } : {}),
    ...(identity ? { identity } : {}),
    ...(signal ? { signal } : {}),
    nextActionIndex: () => ++actionIndex,
  });
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
  if (terminal.actionId !== frame.actionId) {
    throw new Error(
      `Action run '${frame.actionRunId}' belongs to '${terminal.actionId}', not '${frame.actionId}'.`,
    );
  }
  if (!sameActionValue(terminal.input, input)) {
    throw new Error(
      `Action run '${frame.actionRunId}' was retried with different input.`,
    );
  }
  return terminal;
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
): (input: unknown, options?: ActionCallOptions) => Promise<unknown> {
  return async (input, options = {}) => {
    const frame = createFrame(action, options, parent, invoker);
    throwIfAborted(frame.signal);

    // Executed values and persisted values are deliberately identical.
    const durableInput = durableActionValue(input);
    const existing = await loadTerminal(
      invoker.actionLifecycle,
      frame,
      durableInput,
    );
    if (existing) return restoreTerminal(existing);

    await invoker.actionLifecycle.emit({
      ...lifecycleCommon(frame, durableInput),
      status: "invoked",
      deduplicationId: `${frame.actionRunId}:action:invoked`,
    });

    let progressIndex = 0;
    let progressTail: Promise<void> = Promise.resolve();
    const progress = (value: unknown): Promise<void> => {
      const index = ++progressIndex;
      const durableProgress = durableActionValue(value);
      progressTail = progressTail.then(async () => {
        await invoker.actionLifecycle.emit({
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
    ) as Readonly<
      Record<
        string,
        (input: unknown, options?: ActionCallOptions) => Promise<unknown>
      >
    >;
    const context = invoker.createContext({
      frame,
      actions: nestedActions,
      progress,
    });

    try {
      if (action.inputSchema) {
        validateAgainstJsonSchema(
          action.inputSchema,
          durableInput,
          `Action '${action.id}' input`,
        );
      }
      throwIfAborted(frame.signal);
      const output = await action.execute(
        durableInput as never,
        context as never,
      );
      await progressTail;
      throwIfAborted(frame.signal);
      if (action.outputSchema) {
        validateAgainstJsonSchema(
          action.outputSchema,
          output,
          `Action '${action.id}' output`,
        );
      }
      const durableOutput = durableActionValue(output);
      try {
        await invoker.actionLifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status: "completed",
          output: durableOutput,
          deduplicationId: `${frame.actionRunId}:action:terminal`,
        });
      } catch (error) {
        const terminal = await loadTerminal(
          invoker.actionLifecycle,
          frame,
          durableInput,
        );
        if (terminal) return restoreTerminal(terminal);
        throw error;
      }
      return structuredClone(durableOutput);
    } catch (error) {
      const existingTerminal = await loadTerminal(
        invoker.actionLifecycle,
        frame,
        durableInput,
      );
      if (existingTerminal) return restoreTerminal(existingTerminal);
      const status = frame.signal?.aborted || isCancellationError(error)
        ? "cancelled" as const
        : "failed" as const;
      try {
        await invoker.actionLifecycle.emit({
          ...lifecycleCommon(frame, durableInput),
          status,
          error: safeError(error),
          deduplicationId: `${frame.actionRunId}:action:terminal`,
        });
      } catch (settlementError) {
        const terminal = await loadTerminal(
          invoker.actionLifecycle,
          frame,
          durableInput,
        );
        if (terminal) return restoreTerminal(terminal);
        throw settlementError;
      }
      throw settledActionError(error);
    }
  };
}

/** Builds the single direct Action API from the composed Action alias map. */
export function createActionCallers<const TActions extends ActionMap>(
  actions: TActions,
  options: CreateActionCallersOptions,
  parent?: ActionInvocationFrame,
): ActionCallers<TActions> {
  const entries = Object.entries(actions).map(([rawAlias, action]) => [
    requireAlias(rawAlias),
    actionCaller(action, actions, options, parent),
  ]);
  return Object.freeze(Object.fromEntries(entries)) as ActionCallers<TActions>;
}
