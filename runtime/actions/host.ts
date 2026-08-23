import type {
  CollectionDefinition,
  CollectionRuntime,
  CollectionTransactionCollections,
  ScopedCollections,
} from "../collections/index.ts";
import type {
  AssetOrigin,
  AssetRecord,
  BodyStore,
  ContentInput,
  ContentRef,
  ContentResolver,
  ContentSequence,
  ContentStreamRuntime,
  DurableContentInput,
  PreparedContent,
  PublishAssetInput,
  ResolvedContent,
} from "../content/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import {
  type ActionInvocationFrame,
  actionTransactionIdentity,
  createActionCallers,
} from "./invoker.ts";
import type {
  ActionCallers,
  ActionCallOptions,
  ActionContext,
  ActionLifecycleAppender,
  ActionLifecycleLoader,
  ActionTransactionContext,
  ActionTransactionOptions,
  RuntimeContext,
} from "./types.ts";

export type ActionContentHandle = Readonly<{
  resolver: Pick<ContentResolver, "getMany">;
  stream: ContentStreamRuntime;
  bodies?: BodyStore;
  prepare(
    input: ContentInput | readonly ContentInput[],
    options: { operationKey: string; origin?: AssetOrigin },
  ): Promise<PreparedContent>;
  materialize(
    input: DurableContentInput,
    options?: { origin?: AssetOrigin },
  ): Promise<ContentSequence>;
  publish(
    input: Omit<PublishAssetInput, "namespace" | "idempotencyKey">,
    options: { operationKey: string },
  ): Promise<AssetRecord>;
  get(assetId: string): Promise<AssetRecord | null>;
  getMany(assetIds: readonly string[]): Promise<readonly AssetRecord[]>;
  resolve(ref: ContentRef): Promise<ResolvedContent>;
  resolveMany(refs: readonly ContentRef[]): Promise<readonly ResolvedContent[]>;
  open(ref: ContentRef): Promise<ReadableStream<Uint8Array>>;
}>;

export type ActionHostContext = Readonly<{
  namespace: string;
  resources: PluginRegistry["resources"];
  adapters: PluginRegistry["adapters"];
  actions: ActionCallers;
  collections: ScopedCollections;
  content: ActionContentHandle;
  streams: ContentStreamRuntime;
  signal: AbortSignal;
  now(): Date;
  transaction: ActionContext["transaction"];
}>;

export type ActionContextBindings = Readonly<{
  namespace: string;
  plugins: PluginRegistry;
  collections: CollectionRuntime;
  transaction?: CollectionRuntime["transaction"];
  actionLifecycle: Readonly<{
    append: ActionLifecycleAppender;
    load: ActionLifecycleLoader;
  }>;
  now?: () => Date;
  content(namespace: string): ActionContentHandle;
}>;

function scopedCollections(bindings: ActionContextBindings): ScopedCollections {
  const byName = bindings.collections.withScope({
    namespace: bindings.namespace,
  });
  const aliases = Object.fromEntries(
    Object.entries(bindings.plugins.collections).map(([alias, definition]) => {
      const collection = byName[(definition as CollectionDefinition).name];
      if (!collection) {
        throw new Error(
          `Collection '${definition.name}' for alias '${alias}' is not bound.`,
        );
      }
      return [alias, collection];
    }),
  );
  return Object.freeze(aliases) as ScopedCollections;
}

function scopedTransactionCollections(
  plugins: PluginRegistry,
  byName: CollectionTransactionCollections,
): ActionTransactionContext["collections"] {
  return Object.freeze(Object.fromEntries(
    Object.entries(plugins.collections).map(([alias, definition]) => {
      const collection = byName[(definition as CollectionDefinition).name];
      if (!collection) {
        throw new Error(
          `Collection '${definition.name}' for alias '${alias}' is not bound.`,
        );
      }
      return [alias, collection];
    }),
  ));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("This operation was aborted.", "AbortError");
}

type ActionInvocationHost = Pick<
  RuntimeContext,
  | "namespace"
  | "resources"
  | "adapters"
  | "collections"
  | "content"
  | "streams"
  | "signal"
  | "now"
  | "transaction"
>;

/** Adds invocation lifecycle state to the shared runtime context. */
export function createActionInvocationContext(
  options: Readonly<{
    host: ActionInvocationHost;
    frame: ActionInvocationFrame;
    actions: Readonly<
      Record<
        string,
        (input: unknown, options?: ActionCallOptions) => Promise<unknown>
      >
    >;
    progress(value: unknown): Promise<void>;
  }>,
): ActionContext {
  const { frame, host } = options;
  let transactionIndex = 0;
  const content = Object.freeze({
    ...host.content,
    prepare(
      input: Parameters<typeof host.content.prepare>[0],
      prepareOptions: Parameters<typeof host.content.prepare>[1],
    ) {
      return host.content.prepare(input, {
        ...prepareOptions,
        operationKey: `${frame.operationKey}/${prepareOptions.operationKey}`,
      });
    },
    publish(
      input: Parameters<typeof host.content.publish>[0],
      publishOptions: Parameters<typeof host.content.publish>[1],
    ) {
      return host.content.publish(input, {
        ...publishOptions,
        operationKey: `${frame.operationKey}/${publishOptions.operationKey}`,
      });
    },
  });
  return Object.freeze({
    ...host,
    action: Object.freeze({
      id: frame.actionId,
      runId: frame.actionRunId,
      ...(frame.parentActionRunId
        ? { parentRunId: frame.parentActionRunId }
        : {}),
    }),
    operationKey: frame.operationKey,
    identity: Object.freeze({ ...(frame.identity ?? {}) }),
    actions: options.actions,
    content,
    signal: frame.signal,
    progress: options.progress,
    transaction: (
      execute: Parameters<ActionContext["transaction"]>[0],
      transactionOptions: ActionTransactionOptions = {},
    ) => {
      const localKey = transactionOptions.operationKey?.trim() ||
        `transaction:${++transactionIndex}`;
      const identity = actionTransactionIdentity(
        frame.identity,
        transactionOptions.identity,
      );
      return host.transaction(execute as never, {
        ...transactionOptions,
        operationKey: `${frame.operationKey}/${localKey}`,
        ...(identity ? { identity } : {}),
        signal: transactionOptions.signal ?? frame.signal,
      }) as never;
    },
  }) as ActionContext;
}

/** Builds the direct Action host for one trusted namespace scope. */
export function createActionContext(
  bindings: ActionContextBindings,
): ActionHostContext {
  const namespace = bindings.namespace.trim();
  if (!namespace) throw new TypeError("Namespace must be non-empty.");
  const collections = scopedCollections({ ...bindings, namespace });
  const runtimeTransaction = bindings.transaction ??
    bindings.collections.transaction;
  const content = bindings.content(namespace);
  const lifecycle = createActionLifecycleEmitter({
    namespace,
    append: bindings.actionLifecycle.append,
    load: bindings.actionLifecycle.load,
  });
  const signal = new AbortController().signal;

  const transact = async <T>(
    execute: (context: ActionTransactionContext) => T | Promise<T>,
    options: ActionTransactionOptions = {},
  ): Promise<T> => {
    throwIfAborted(options.signal);
    const operationKey = options.operationKey?.trim() ||
      `action-context:${crypto.randomUUID()}`;
    const result = await runtimeTransaction({
      operationKey,
      namespace,
      ...(options.identity ? { identity: options.identity } : {}),
      execute: async ({ collections: byName, relations }) => {
        throwIfAborted(options.signal);
        return await execute(Object.freeze({
          collections: scopedTransactionCollections(
            bindings.plugins,
            byName,
          ),
          relations,
        }));
      },
    });
    throwIfAborted(options.signal);
    return result.value;
  };

  const actions = createActionCallers(bindings.plugins.actions, {
    actionLifecycle: lifecycle,
    signal,
    createInvocationKey: () => `invocation:${crypto.randomUUID()}`,
    createContext({ frame, actions: nestedActions, progress }) {
      return createActionInvocationContext({
        host,
        frame,
        actions: nestedActions,
        progress,
      });
    },
  });

  const host: ActionHostContext = Object.freeze({
    namespace,
    resources: bindings.plugins.resources,
    adapters: bindings.plugins.adapters,
    actions,
    collections,
    content,
    streams: content.stream,
    signal,
    now: bindings.now ?? (() => new Date()),
    transaction: transact,
  });
  return host;
}
