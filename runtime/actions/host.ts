import type {
  CollectionDefinition,
  CollectionRuntime,
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
import type {
  DomainRelation,
  ListDomainRelationsOptions,
  ProjectDomainRelationInput,
} from "../domain/index.ts";
import type { DurableEvent, EventDelivery } from "../events/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import { createActionLifecycleEmitter } from "./lifecycle.ts";
import { actionTransactionIdentity, createActionCallers } from "./invoker.ts";
import type {
  ActionCallers,
  ActionContext,
  ActionLifecycleAppender,
  ActionLifecycleLoader,
  ActionTransactionContext,
  ActionTransactionOptions,
} from "./types.ts";

export type ActionContentHandle = Readonly<{
  resolver: Pick<ContentResolver, "getMany">;
  stream?: ContentStreamRuntime;
  bodies?: BodyStore;
  prepare(
    input: ContentInput | readonly ContentInput[],
    options: { operationKey: string; origin?: AssetOrigin },
  ): Promise<PreparedContent>;
  materialize(
    input: DurableContentInput,
    options?: { origin?: AssetOrigin },
  ): Promise<ContentSequence>;
  linkOwner(ownerId: string, content: ContentSequence): Promise<void>;
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
  streams?: ContentStreamRuntime;
  now(): Date;
  transaction: ActionContext["transaction"];
  events: Readonly<{
    list(options?: {
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
  }>;
  deliveries: Readonly<{
    list(options?: {
      eventId?: string;
      consumerId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
  }>;
  relations: Readonly<{
    list(
      options?: Omit<ListDomainRelationsOptions, "namespace">,
    ): Promise<readonly DomainRelation[]>;
  }>;
}>;

export type ActionContextBindings = Readonly<{
  namespace: string;
  plugins: PluginRegistry;
  collections?: {
    withScope(scope: { namespace: string }): ScopedCollections;
  };
  collectionRuntime: CollectionRuntime;
  transaction?: CollectionRuntime["transaction"];
  actionLifecycle: Readonly<{
    append: ActionLifecycleAppender;
    load: ActionLifecycleLoader;
  }>;
  now?: () => Date;
  contentResolver: Pick<ContentResolver, "getMany">;
  content?: (namespace: string) => ActionContentHandle;
  events: {
    list(options: {
      namespace: string;
      threadId?: string;
      correlationId?: string;
      afterPosition?: string;
      limit?: number;
    }): Promise<readonly DurableEvent[]>;
  };
  deliveries: {
    list(options: {
      namespace: string;
      eventId?: string;
      consumerId?: string;
      status?: EventDelivery["status"];
      limit?: number;
    }): Promise<readonly EventDelivery[]>;
  };
  relations: {
    list(
      options: ListDomainRelationsOptions,
    ): Promise<readonly DomainRelation[]>;
    upsert?(
      input: ProjectDomainRelationInput,
    ): Promise<DomainRelation>;
  };
}>;

function scopedCollections(bindings: ActionContextBindings): ScopedCollections {
  const byName = Object.freeze({
    ...bindings.collections?.withScope({ namespace: bindings.namespace }),
    ...bindings.collectionRuntime.withScope({ namespace: bindings.namespace }),
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

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("This operation was aborted.", "AbortError");
}

/** Builds the direct Action host for one trusted namespace scope. */
export function createActionContext(
  bindings: ActionContextBindings,
): ActionHostContext {
  const namespace = bindings.namespace.trim();
  if (!namespace) throw new TypeError("Namespace must be non-empty.");
  const collections = scopedCollections({ ...bindings, namespace });
  const runtimeTransaction = bindings.transaction ??
    bindings.collectionRuntime.transaction;
  const content: ActionContentHandle = bindings.content?.(namespace) ??
    Object.freeze({
      resolver: bindings.contentResolver,
      prepare() {
        throw new Error("Action content preparation is not configured.");
      },
      materialize() {
        throw new Error("Action content materialization is not configured.");
      },
      linkOwner() {
        throw new Error("Action content ownership is not configured.");
      },
      publish() {
        throw new Error("Action content publication is not configured.");
      },
      get() {
        throw new Error("Action content lookup is not configured.");
      },
      getMany() {
        throw new Error("Action content lookup is not configured.");
      },
      resolve() {
        throw new Error("Action content resolution is not configured.");
      },
      resolveMany() {
        throw new Error("Action content resolution is not configured.");
      },
      open() {
        throw new Error("Action content streaming is not configured.");
      },
    });
  const lifecycle = createActionLifecycleEmitter({
    namespace,
    append: bindings.actionLifecycle.append,
    load: bindings.actionLifecycle.load,
  });

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
      execute: async () => {
        throwIfAborted(options.signal);
        const relations = Object.freeze({
          upsert(
            input: Parameters<
              ActionTransactionContext["relations"]["upsert"]
            >[0],
          ) {
            if (!bindings.relations.upsert) {
              throw new Error(
                "Action transaction relation projection is not configured.",
              );
            }
            return bindings.relations.upsert({ ...input, namespace });
          },
        });
        return await execute(Object.freeze({ collections, relations }));
      },
    });
    throwIfAborted(options.signal);
    return result.value;
  };

  const actions = createActionCallers(bindings.plugins.actions, {
    actionLifecycle: lifecycle,
    createInvocationKey: () => `invocation:${crypto.randomUUID()}`,
    createContext({ frame, actions: nestedActions, progress }) {
      let transactionIndex = 0;
      const actionContent = Object.freeze({
        ...content,
        prepare(
          input: Parameters<ActionContentHandle["prepare"]>[0],
          options: Parameters<ActionContentHandle["prepare"]>[1],
        ) {
          return content.prepare(input, {
            ...options,
            operationKey: `${frame.operationKey}/${options.operationKey}`,
          });
        },
        publish(
          input: Parameters<ActionContentHandle["publish"]>[0],
          options: Parameters<ActionContentHandle["publish"]>[1],
        ) {
          return content.publish(input, {
            ...options,
            operationKey: `${frame.operationKey}/${options.operationKey}`,
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
        actions: nestedActions,
        content: actionContent,
        streams: content.stream,
        ...(frame.signal ? { signal: frame.signal } : {}),
        progress,
        transaction: (
          execute: Parameters<ActionContext["transaction"]>[0],
          options: ActionTransactionOptions = {},
        ) => {
          const localKey = options.operationKey?.trim() ||
            `transaction:${++transactionIndex}`;
          const identity = actionTransactionIdentity(
            frame.identity,
            options.identity,
          );
          return transact(execute as never, {
            ...options,
            operationKey: `${frame.operationKey}/${localKey}`,
            ...(identity ? { identity } : {}),
            signal: options.signal ?? frame.signal,
          }) as never;
        },
      }) as ActionContext;
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
    now: bindings.now ?? (() => new Date()),
    transaction: transact,
    events: Object.freeze({
      list(options = {}) {
        return bindings.events.list({ ...options, namespace });
      },
    }),
    deliveries: Object.freeze({
      list(options = {}) {
        return bindings.deliveries.list({ ...options, namespace });
      },
    }),
    relations: Object.freeze({
      list(options = {}) {
        return bindings.relations.list({ ...options, namespace });
      },
    }),
  });
  return host;
}
