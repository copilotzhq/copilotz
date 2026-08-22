import { validateAgainstJsonSchema } from "../collections/validate.ts";
import {
  activeCollectionTransaction,
  type CollectionRuntime,
} from "../collections/index.ts";
import type {
  CollectionDefinition,
  ScopedCollections,
} from "../collections/index.ts";
import type {
  AnyFeatureDefinition,
  ErasedFeatureAction,
  FeatureActionsFor,
  FeatureCallOptions,
  FeatureContextBindings,
  FeatureContextValues,
  FeatureExecuteContext,
  FeatureHostContext,
  FeatureInvoker,
  FeatureTransactionContext,
  FeatureTransactionOptions,
} from "./types.ts";
import { isFeatureDefinition } from "./define.ts";
import type { PluginContextValues } from "../plugins/index.ts";
import type { ContextResource } from "../context/types.ts";
import {
  type ActionLifecycleEmitter,
  createActionLifecycleEmitter,
  sameActionValue,
  type SerializedActionError,
} from "../actions/index.ts";

const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const settledActionErrors = new WeakSet<object>();

function settledActionError(error: unknown): unknown {
  if (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
  ) {
    settledActionErrors.add(error as object);
    return error;
  }
  const wrapped = new Error(String(error), { cause: error });
  settledActionErrors.add(wrapped);
  return wrapped;
}

/** True only after the Action's failed/cancelled lifecycle Event is durable. */
export function isSettledFeatureActionError(error: unknown): boolean {
  return ((typeof error === "object" && error !== null) ||
    typeof error === "function") &&
    settledActionErrors.has(error as object);
}

function requireAlias(alias: string, label: string): string {
  const normalized = alias.trim();
  if (!ALIAS_PATTERN.test(normalized)) {
    throw new TypeError(`${label} has invalid alias '${alias}'.`);
  }
  return normalized;
}

function requireFeature(
  value: unknown,
  label: string,
): AnyFeatureDefinition {
  if (!isFeatureDefinition(value)) {
    throw new TypeError(
      `${label} must be a Feature definition.`,
    );
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("This operation was aborted.", "AbortError");
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export type FeatureTransaction = CollectionRuntime["transaction"];

export type CreateFeatureInvokerOptions = Readonly<{
  isTransactionActive?: () => boolean;
  createInvocationKey?: () => string;
  identity?: FeatureCallOptions["identity"];
  actionLifecycle?: ActionLifecycleEmitter;
  upsertRelation?: FeatureContextBindings["relations"]["upsert"];
}>;

type InvocationFrame = Readonly<{
  rootKey: string;
  path: string;
  identity?: FeatureCallOptions["identity"];
  signal?: AbortSignal;
  transactionActive: boolean;
  parentActionRunId?: string;
  nextTransactionIndex(): number;
}>;

function invocationSegment(
  feature: AnyFeatureDefinition,
  actionName: string,
): string {
  return `feature:${feature.id}:${actionName}`;
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
  parent: FeatureCallOptions["identity"],
  child: FeatureCallOptions["identity"],
): FeatureCallOptions["identity"] {
  if (!parent) return child;
  if (!child) return parent;
  return Object.freeze({
    causationId: child.causationId ?? parent.causationId,
    correlationId: child.correlationId ?? parent.correlationId,
    deduplicationId: child.deduplicationId ?? parent.deduplicationId,
    settlementScopeId: child.settlementScopeId ?? parent.settlementScopeId,
  });
}

function createFrame(
  feature: AnyFeatureDefinition,
  actionName: string,
  options: FeatureCallOptions,
  parent: InvocationFrame | undefined,
  invokerOptions: CreateFeatureInvokerOptions,
): InvocationFrame {
  const segment = invocationSegment(feature, actionName);
  const explicitOperationKey = options.operationKey?.trim() || undefined;
  const identity = mergeIdentity(
    parent?.identity ?? invokerOptions.identity,
    options.identity,
  );
  const deduplicationRoot = identity?.deduplicationId?.trim() ||
    undefined;
  const transactionActive = invokerOptions.isTransactionActive?.() ?? false;
  const hostInvocationKey = parent || transactionActive
    ? undefined
    : invokerOptions.createInvocationKey?.();
  const localPath = (parent || hostInvocationKey) && explicitOperationKey
    ? `${segment}/${explicitOperationKey}`
    : segment;
  const rootKey = parent?.rootKey ??
    (transactionActive ? "" : hostInvocationKey) ??
    explicitOperationKey ?? deduplicationRoot ??
    `invocation:${crypto.randomUUID()}`;
  const path = parent
    ? `${parent.path}/${localPath}`
    : transactionActive
    ? localPath
    : `${rootKey}/${localPath}`;
  let transactionIndex = 0;
  return Object.freeze({
    rootKey,
    path,
    identity,
    signal: mergeSignal(parent?.signal, options.signal),
    transactionActive,
    ...(parent ? { parentActionRunId: parent.path } : {}),
    nextTransactionIndex: () => ++transactionIndex,
  });
}

function collectionHandle(
  collections: ScopedCollections,
  definition: Pick<CollectionDefinition, "name">,
) {
  const collection = collections[definition.name];
  if (!collection) {
    throw new TypeError(`Collection '${definition.name}' is not bound.`);
  }
  return collection;
}

function safeError(error: unknown): SerializedActionError {
  if (error instanceof Error) {
    return Object.freeze({
      name: error.name || "Error",
      message: error.message || error.name || "Action failed.",
      ...(error.stack ? { stack: error.stack } : {}),
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
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

async function emitFeatureActionLifecycle(
  options: CreateFeatureInvokerOptions,
  frame: InvocationFrame,
  feature: AnyFeatureDefinition,
  actionName: string,
  status: "invoked" | "completed" | "failed" | "cancelled",
  input: unknown,
  output?: unknown,
  error?: unknown,
): Promise<void> {
  if (!options.actionLifecycle) return;
  const actionRunId = frame.path;
  const actionId = `${feature.id}.${actionName}`;
  const common = {
    actionRunId,
    actionId,
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
    deduplicationId: `${actionRunId}:action:${status}`,
    ...(frame.identity?.settlementScopeId
      ? { settlementScopeId: frame.identity.settlementScopeId }
      : {}),
  };
  if (status === "completed") {
    await options.actionLifecycle.emit({
      ...common,
      status,
      output,
    });
    return;
  }
  if (status === "failed" || status === "cancelled") {
    await options.actionLifecycle.emit({
      ...common,
      status,
      error: safeError(error),
    });
    return;
  }
  await options.actionLifecycle.emit({
    ...common,
    status,
  });
}

export function createFeatureContextValues(
  context: PluginContextValues = Object.freeze({}),
): FeatureContextValues {
  const namespaces: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [namespace, values] of Object.entries(context)) {
    namespaces[namespace] = Object.freeze({ ...values });
  }
  return Object.freeze({
    ...namespaces,
    agents: Object.freeze({
      ...(namespaces.agents ?? {}),
    }) as FeatureContextValues["agents"],
    tools: Object.freeze({
      ...(namespaces.tools ?? {}),
    }) as FeatureContextValues["tools"],
    llm: Object.freeze({
      ...(namespaces.llm ?? {}),
    }) as FeatureContextValues["llm"],
    apis: Object.freeze({
      ...(namespaces.apis ?? {}),
    }) as FeatureContextValues["apis"],
    mcp: Object.freeze({
      ...(namespaces.mcp ?? {}),
    }) as FeatureContextValues["mcp"],
    skills: Object.freeze({
      ...(namespaces.skills ?? {}),
    }) as FeatureContextValues["skills"],
    embeddings: Object.freeze({
      ...(namespaces.embeddings ?? {}),
    }) as Readonly<Record<string, unknown | undefined>>,
    promptContext: Object.freeze({
      ...(namespaces.promptContext ?? {}),
    }) as Readonly<Record<string, ContextResource | undefined>>,
    featureDefinitions: Object.freeze({
      ...(namespaces.featureDefinitions ?? {}),
    }) as FeatureContextValues["featureDefinitions"],
  });
}

function transactionOperationKey(
  frame: InvocationFrame,
  options: FeatureTransactionOptions | undefined,
): string {
  const explicit = options?.operationKey?.trim();
  const local = explicit || `transaction:${frame.nextTransactionIndex()}`;
  return frame.transactionActive ? local : `${frame.path}/${local}`;
}

function transactionContext(
  collections: ScopedCollections,
  upsertRelation?: FeatureContextBindings["relations"]["upsert"],
  namespace?: string,
): FeatureTransactionContext {
  return Object.freeze({
    collections,
    collection(definition) {
      return collectionHandle(collections, definition) as never;
    },
    relations: Object.freeze({
      upsert(
        input: Parameters<FeatureTransactionContext["relations"]["upsert"]>[0],
      ) {
        if (!upsertRelation || !namespace) {
          throw new Error(
            "Feature transaction relation projection is not configured.",
          );
        }
        return upsertRelation({ ...input, namespace });
      },
    }),
  });
}

function createExecuteContext(
  hostContext: FeatureHostContext,
  host: () => FeatureHostContext,
  transaction: FeatureTransaction,
  invokerOptions: CreateFeatureInvokerOptions,
  frame: InvocationFrame,
): FeatureExecuteContext {
  const content = Object.freeze({
    ...hostContext.content,
    prepare(
      input: Parameters<FeatureExecuteContext["content"]["prepare"]>[0],
      options: Parameters<FeatureExecuteContext["content"]["prepare"]>[1],
    ) {
      return hostContext.content.prepare(input, {
        ...options,
        operationKey: `${frame.path}/${options.operationKey}`,
      });
    },
    publish(
      input: Parameters<FeatureExecuteContext["content"]["publish"]>[0],
      options: Parameters<FeatureExecuteContext["content"]["publish"]>[1],
    ) {
      return hostContext.content.publish(input, {
        ...options,
        operationKey: `${frame.path}/${options.operationKey}`,
      });
    },
  });
  return Object.freeze({
    ...hostContext,
    namespace: hostContext.namespace,
    operationKey: frame.path,
    now: hostContext.now,
    collections: hostContext.collections,
    collection(definition) {
      return collectionHandle(hostContext.collections, definition) as never;
    },
    transaction: async (execute, options = {}) => {
      const signal = mergeSignal(frame.signal, options.signal);
      throwIfAborted(signal);
      const operationKey = transactionOperationKey(frame, options);
      const result = await transaction({
        operationKey,
        namespace: hostContext.namespace,
        identity: {
          ...(frame.identity ?? {}),
          ...(options.identity ?? {}),
        },
        execute: async () => {
          throwIfAborted(signal);
          return await execute(
            transactionContext(
              hostContext.collections,
              invokerOptions.upsertRelation,
              hostContext.namespace,
            ),
          );
        },
      });
      throwIfAborted(signal);
      return result.value;
    },
    content,
    agents: hostContext.agents,
    tools: hostContext.tools,
    llm: hostContext.llm,
    apis: hostContext.apis,
    mcp: hostContext.mcp,
    skills: hostContext.skills,
    embeddings: hostContext.embeddings,
    promptContext: hostContext.promptContext,
    featureDefinitions: hostContext.featureDefinitions,
    features: hostContext.features,
    feature(definition) {
      return featureActions(
        definition,
        host,
        transaction,
        invokerOptions,
        frame,
      );
    },
    events: hostContext.events,
    deliveries: hostContext.deliveries,
    relations: hostContext.relations,
    ...(frame.signal ? { signal: frame.signal } : {}),
  }) as FeatureExecuteContext;
}

function actionInvoker(
  feature: AnyFeatureDefinition,
  actionName: string,
  action: ErasedFeatureAction,
  host: () => FeatureHostContext,
  transaction: FeatureTransaction,
  invokerOptions: CreateFeatureInvokerOptions,
  parent?: InvocationFrame,
): (input: unknown, options?: FeatureCallOptions) => Promise<unknown> {
  return async (input: unknown, options: FeatureCallOptions = {}) => {
    const frame = createFrame(
      feature,
      actionName,
      options,
      parent,
      invokerOptions,
    );
    throwIfAborted(frame.signal);
    const hostContext = host();
    const executeContext = createExecuteContext(
      hostContext,
      host,
      transaction,
      invokerOptions,
      frame,
    );
    const terminal = await invokerOptions.actionLifecycle?.terminal(frame.path);
    if (terminal) {
      const actionId = `${feature.id}.${actionName}`;
      if (terminal.actionId !== actionId) {
        throw new Error(
          `Action run '${frame.path}' belongs to '${terminal.actionId}', not '${actionId}'.`,
        );
      }
      if (!sameActionValue(terminal.input, input)) {
        throw new Error(
          `Action run '${frame.path}' was retried with different input.`,
        );
      }
      if (terminal.status === "completed") {
        return structuredClone(terminal.output);
      }
      throw settledActionError(
        restoredActionError(terminal.status, terminal.error),
      );
    }
    await emitFeatureActionLifecycle(
      invokerOptions,
      frame,
      feature,
      actionName,
      "invoked",
      input,
    );
    try {
      if (action.inputSchema) {
        validateAgainstJsonSchema(
          action.inputSchema as object,
          input,
          `Feature '${feature.id}' action '${actionName}' input`,
        );
      }
      throwIfAborted(frame.signal);
      const output = await action.execute(
        input as never,
        executeContext as never,
      );
      if (action.outputSchema) {
        validateAgainstJsonSchema(
          action.outputSchema as object,
          output,
          `Feature '${feature.id}' action '${actionName}' output`,
        );
      }
      await emitFeatureActionLifecycle(
        invokerOptions,
        frame,
        feature,
        actionName,
        "completed",
        input,
        output,
      );
      return output;
    } catch (error) {
      await emitFeatureActionLifecycle(
        invokerOptions,
        frame,
        feature,
        actionName,
        frame.signal?.aborted || isCancellationError(error)
          ? "cancelled"
          : "failed",
        input,
        undefined,
        error,
      );
      throw settledActionError(error);
    }
  };
}

/** Builds a consumer-local Feature invoker from declared aliases. */
export function createFeatureInvoker(
  aliases: Readonly<Record<string, AnyFeatureDefinition>>,
  host: () => FeatureHostContext,
  transaction: FeatureTransaction,
  options: CreateFeatureInvokerOptions = {},
  parent?: InvocationFrame,
): FeatureInvoker {
  if (!transaction) throw new TypeError("Feature transaction is required.");
  const ids = new Map<string, string>();
  const entries = Object.entries(aliases).map(([rawAlias, definition]) => {
    const alias = requireAlias(rawAlias, "Feature");
    const feature = requireFeature(definition, `Feature alias '${alias}'`);
    const existing = ids.get(alias);
    if (existing && existing !== feature.id) {
      throw new TypeError(
        `Feature alias '${alias}' is declared by both '${existing}' and '${feature.id}'.`,
      );
    }
    ids.set(alias, feature.id);
    const actions = Object.freeze(Object.fromEntries(
      Object.entries(feature.actions).map(([actionName, action]) => [
        actionName,
        actionInvoker(
          feature,
          actionName,
          action,
          host,
          transaction,
          options,
          parent,
        ),
      ]),
    ));
    return [alias, actions] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

function featureActions<F extends AnyFeatureDefinition>(
  definition: F,
  host: () => FeatureHostContext,
  transaction: FeatureTransaction,
  options: CreateFeatureInvokerOptions = {},
  parent?: InvocationFrame,
): FeatureActionsFor<F> {
  return createFeatureInvoker(
    { bound: definition },
    host,
    transaction,
    options,
    parent,
  ).bound as FeatureActionsFor<F>;
}

/** Internal bridge for pre-10B3 runtime mechanisms; not a package API. */
export function requireFeatureActions(
  context: Pick<FeatureHostContext, "feature" | "featureDefinitions">,
  id: string,
): FeatureInvoker[string] {
  const definition = context.featureDefinitions[id];
  if (!definition) throw new Error(`Unknown Feature '${id}'.`);
  return context.feature(definition);
}

/** Builds a FeatureContext from engine primitives, not the application. */
export function createFeatureContext(
  bindings: FeatureContextBindings,
): FeatureHostContext {
  const namespace = bindings.namespace.trim();
  if (!namespace) throw new TypeError("Namespace must be non-empty.");
  const holder: { current?: FeatureHostContext } = {};
  const transaction = bindings.transaction ??
    bindings.collectionRuntime.transaction;
  const host = () => {
    if (!holder.current) {
      throw new Error("Feature context is not ready.");
    }
    return holder.current;
  };
  const actions = bindings.actionLifecycle
    ? createActionLifecycleEmitter({
      namespace,
      append: bindings.actionLifecycle.append,
      load: bindings.actionLifecycle.load,
    })
    : undefined;
  const features = createFeatureInvoker(
    bindings.featureAliases ?? {},
    host,
    transaction,
    {
      isTransactionActive: () =>
        activeCollectionTransaction(bindings.collectionRuntime) !== undefined,
      actionLifecycle: actions,
      upsertRelation: bindings.relations.upsert,
    },
  );
  const scopedCollections = Object.freeze({
    ...bindings.collections?.withScope({ namespace }),
    ...bindings.collectionRuntime.withScope({ namespace }),
  });
  const context: FeatureHostContext = Object.freeze({
    namespace,
    ...createFeatureContextValues(bindings.plugins.context),
    now: bindings.now ?? (() => new Date()),
    collections: scopedCollections,
    collection(definition) {
      return collectionHandle(scopedCollections, definition) as never;
    },
    transaction: async (execute, options = {}) => {
      const operationKey = options.operationKey?.trim() ||
        `feature-context:${crypto.randomUUID()}`;
      const result = await transaction({
        operationKey,
        namespace,
        ...(options.identity ? { identity: options.identity } : {}),
        execute: async () =>
          await execute(
            transactionContext(
              scopedCollections,
              bindings.relations.upsert,
              namespace,
            ),
          ),
      });
      return result.value;
    },
    content: bindings.content?.(namespace) ?? Object.freeze({
      resolver: bindings.contentResolver,
      prepare() {
        throw new Error("Feature content preparation is not configured.");
      },
      materialize() {
        throw new Error("Feature content materialization is not configured.");
      },
      linkOwner() {
        throw new Error("Feature content ownership is not configured.");
      },
      publish() {
        throw new Error("Feature content publication is not configured.");
      },
      get() {
        throw new Error("Feature content lookup is not configured.");
      },
      getMany() {
        throw new Error("Feature content lookup is not configured.");
      },
      resolve() {
        throw new Error("Feature content resolution is not configured.");
      },
      resolveMany() {
        throw new Error("Feature content resolution is not configured.");
      },
      open() {
        throw new Error("Feature content streaming is not configured.");
      },
    }),
    features,
    feature(definition) {
      return featureActions(definition, host, transaction, {
        isTransactionActive: () =>
          activeCollectionTransaction(bindings.collectionRuntime) !== undefined,
        actionLifecycle: actions,
        upsertRelation: bindings.relations.upsert,
      });
    },
    events: {
      list(options = {}) {
        return bindings.events.list({ ...options, namespace });
      },
    },
    deliveries: {
      list(options = {}) {
        return bindings.deliveries.list({ ...options, namespace });
      },
    },
    relations: {
      list(options = {}) {
        return bindings.relations.list({ ...options, namespace });
      },
    },
  });
  holder.current = context;
  return context;
}
