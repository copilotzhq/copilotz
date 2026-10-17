import type { VectorReader } from "../vectors/index.ts";
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
  DurableContentInput,
  PreparedContent,
  PublishAssetInput,
  ResolvedContent,
} from "../content/index.ts";
import type { ContentStreamRuntime } from "../streams/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { createActionCallers } from "./invoker.ts";
import { createActionInvocationContext } from "./execution-context.ts";
export { createActionInvocationContext } from "./execution-context.ts";
import type {
  ActionCallers,
  ActionContext,
  ActionLifecycleAppender,
  ActionLifecycleLoader,
  ActionTransactionContext,
  ActionTransactionOptions,
} from "./types.ts";

export type ActionContentHandle = Readonly<{
  authorize?(ref: ContentRef): Promise<void>;
  resolver:
    & Pick<ContentResolver, "getMany">
    & Partial<Pick<ContentResolver, "authorize">>;
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
  databaseSchema: string;
  resources: PluginRegistry["resources"];
  adapters: PluginRegistry["adapters"];
  actions: ActionCallers;
  collections: ScopedCollections;
  vectors: VectorReader;
  content: ActionContentHandle;
  streams: ContentStreamRuntime;
  signal: AbortSignal;
  signalDeferredWait(waitKey: string): Promise<number>;
  now(): Date;
  transaction: ActionContext["transaction"];
  readSnapshot: ActionContext["readSnapshot"];
}>;

export type ActionContextBindings = Readonly<{
  namespace: string;
  /** Immutable physical persistence scope for this direct Action host. */
  databaseSchema: string;
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
  return aliases as ScopedCollections;
}

function scopedTransactionCollections(
  plugins: PluginRegistry,
  byName: CollectionTransactionCollections,
): ActionTransactionContext["collections"] {
  return (Object.fromEntries(
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

/** Builds the direct Action host for one trusted namespace and database scope. */
export function createActionContext(
  bindings: ActionContextBindings,
): ActionHostContext {
  const namespace = bindings.namespace.trim();
  if (!namespace) throw new TypeError("Namespace must be non-empty.");
  const databaseSchema = bindings.databaseSchema.trim();
  if (!databaseSchema) {
    throw new TypeError("Database schema must be non-empty.");
  }
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
      execute: async ({ collections: byName, relations, vectors }) => {
        throwIfAborted(options.signal);
        return await execute(
          {
            collections: scopedTransactionCollections(
              bindings.plugins,
              byName,
            ),
            relations,
            vectors,
          } as const,
        );
      },
    });
    throwIfAborted(options.signal);
    return result.value;
  };
  const readSnapshot: ActionHostContext["readSnapshot"] = async (execute) =>
    await bindings.collections.readSnapshot(
      { namespace },
      async ({ collections: byName }) => {
        const snapshotCollections = Object.fromEntries(
          Object.entries(bindings.plugins.collections).map(
            ([alias, definition]) => {
              const collection =
                byName[(definition as CollectionDefinition).name];
              if (!collection) {
                throw new Error(
                  `Collection '${definition.name}' for alias '${alias}' is not bound.`,
                );
              }
              return [alias, collection];
            },
          ),
        );
        return await execute(
          ({ collections: snapshotCollections } as const) as never,
        );
      },
    );

  const actions = createActionCallers(bindings.plugins.actions, {
    actionLifecycle: lifecycle,
    content: {
      ...content,
      authorize: content.authorize ?? (async (ref) => {
        if (!content.resolver.authorize) {
          throw new Error("Action content requires an authorization service.");
        }
        await content.resolver.authorize(ref, { namespace, signal });
      }),
    },
    signal,
    createInvocationKey: () => `invocation:${crypto.randomUUID()}`,
    createContext({ frame, actions: nestedActions, progress }) {
      return createActionInvocationContext({
        host,
        frame,
        actions: nestedActions,
        progress,
        registerDeferredWait: () =>
          Promise.reject(
            new Error("Durable Action waits require a delivery runtime."),
          ),
      });
    },
  });

  const host: ActionHostContext = {
    namespace,
    databaseSchema,
    resources: bindings.plugins.resources,
    adapters: bindings.plugins.adapters,
    actions,
    collections,
    vectors: bindings.collections.vectors(namespace),
    content,
    streams: content.stream,
    signal,
    // Direct host executions cannot own durable waiters, so terminal
    // notifications are harmless no-ops; registration still rejects below.
    signalDeferredWait: () => Promise.resolve(0),
    now: bindings.now ?? (() => new Date()),
    transaction: transact,
    readSnapshot,
  } as const;
  return host;
}
