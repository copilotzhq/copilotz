import { createResolvedCollectionReader } from "./resolved-read.ts";
import type { ContentResolver } from "../content/resolver.ts";
import type {
  BoundCollection,
  CollectionScope,
  ScopedCollection,
  ScopedCollectionCallOptions,
  ScopedCollectionDeleteInput,
  ScopedCollectionUpdateInput,
} from "./kernel.ts";
import type { CollectionDefinition } from "./definition.ts";
import type {
  CollectionAggregateQuery,
  CollectionAggregateRow,
  CollectionGraphRelation,
  CollectionQuery,
  CollectionRecord,
  CollectionRelationQuery,
  CollectionWriteOptions,
} from "./types.ts";
import type {
  ResolvedCollectionContent,
  ResolvedCollectionFields,
  ScopedCollectionReadOptions,
} from "./read-options.ts";

type ContextCall<F> = F extends (...args: infer Args) => infer Result
  ? (scope: CollectionScope, ...args: Args) => Result
  : never;
export type CollectionRead<Input, Data> = {
  <const Fields extends readonly string[]>(
    scope: CollectionScope,
    input: Input,
    options: ScopedCollectionReadOptions & {
      content: { fields: Fields; byteLimit?: number };
    },
  ): Promise<ResolvedCollectionFields<Data, Fields[number]>>;
  (
    scope: CollectionScope,
    input: Input,
    options?: ScopedCollectionReadOptions<false>,
  ): Promise<Data>;
  (
    scope: CollectionScope,
    input: Input,
    options?: ScopedCollectionReadOptions,
  ): Promise<ResolvedCollectionContent<Data>>;
  (
    ...args: undefined extends Input ? [scope: CollectionScope]
      : [scope: CollectionScope, input: Input]
  ): Promise<Data>;
};
/** The single public implementation, callable with either explicit or bound scope. */
export type CollectionOperations<
  T extends CollectionRecord = CollectionRecord,
  Insert extends object = Record<string, unknown>,
> = Readonly<{
  definition: CollectionDefinition;
  get: CollectionRead<Readonly<{ id: string }>, T | null>;
  list: CollectionRead<CollectionQuery | undefined, readonly T[]>;
  aggregate: (
    scope: CollectionScope,
    query: CollectionAggregateQuery,
    options?: Pick<ScopedCollectionReadOptions, "signal">,
  ) => Promise<readonly CollectionAggregateRow[]>;
  search: CollectionRead<CollectionQuery, readonly T[]>;
  create: ContextCall<ScopedCollection<T, Insert>["create"]>;
  update: ContextCall<ScopedCollection<T, Insert>["update"]>;
  delete: ContextCall<ScopedCollection<T, Insert>["delete"]>;
  commands: Readonly<
    Record<string, ContextCall<ScopedCollection<T, Insert>["commands"][string]>>
  >;
  queries: Readonly<
    Record<string, ContextCall<ScopedCollection<T, Insert>["queries"][string]>>
  >;
  relations: {
    list: ContextCall<ScopedCollection<T, Insert>["relations"]["list"]>;
  };
}>;

function text(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return value.trim();
}

export function createCollectionOperations(
  collection: BoundCollection,
  services: {
    activeTransaction(): boolean;
    activeSnapshot(): boolean;
    contentResolver?: ContentResolver;
    relations(
      namespace: string,
      query?: CollectionRelationQuery,
    ): Promise<readonly CollectionGraphRelation[]>;
  },
): CollectionOperations {
  const name = collection.definition.name;
  const namespace = (scope: CollectionScope) =>
    text(scope.namespace, "Namespace");
  function writeOptions(
    scope: CollectionScope,
    operation: string,
    id: string | undefined,
    input?: ScopedCollectionCallOptions,
  ): CollectionWriteOptions {
    const ns = namespace(scope);
    if (services.activeTransaction()) {
      const method = operation.startsWith("command:")
        ? `commands.${operation.slice(8)}`
        : operation;
      throw new Error(
        `Use transaction.collections.${name}.${method}() inside context.transaction().`,
      );
    }
    const { operationKey, identity: explicit, ...options } = input ?? {};
    const key = operationKey?.trim() ||
      (id ? `${name}.${operation}:${id}` : undefined);
    if (scope.createMutationIdentity && !key) {
      throw new TypeError(
        `Collection '${name}' ${operation} requires an id or operationKey in a delivery context.`,
      );
    }
    const inherited = key
      ? scope.createMutationIdentity?.(key, {
        collection: name,
        operation,
        ...(id ? { recordId: id } : {}),
        ...explicit?.metadata,
      })
      : undefined;
    const identity = inherited || explicit
      ? {
        causationId: explicit?.causationId ?? inherited?.causationId,
        correlationId: explicit?.correlationId ?? inherited?.correlationId,
        deduplicationId: explicit?.deduplicationId ??
          inherited?.deduplicationId,
        settlementScopeId: explicit?.settlementScopeId ??
          inherited?.settlementScopeId,
        metadata: { ...inherited?.metadata, ...explicit?.metadata },
      }
      : undefined;
    return { ...options, namespace: ns, ...(identity ? { identity } : {}) };
  }
  const read = <Input, Data>(
    operation: (ns: string, input: Input) => Promise<Data>,
  ): CollectionRead<Input, Data> =>
    ((
      scope: CollectionScope,
      input: Input,
      options?: ScopedCollectionReadOptions,
    ) => {
      const ns = namespace(scope);
      if (services.activeSnapshot() && options?.content !== undefined) {
        throw new Error(
          "Content resolution is not allowed inside a read snapshot.",
        );
      }
      return createResolvedCollectionReader(
        (value: Input) => operation(ns, value),
        collection.definition,
        ns,
        services.contentResolver,
      )(input, options);
    }) as CollectionRead<Input, Data>;
  const readWithSignal = async <T>(
    operation: () => Promise<T>,
    options?: Pick<ScopedCollectionReadOptions, "signal">,
  ) => {
    options?.signal?.throwIfAborted();
    const result = await operation();
    options?.signal?.throwIfAborted();
    return result;
  };
  return ({
    definition: collection.definition,
    get: read((ns, input: Readonly<{ id: string }>) =>
      collection.get(text(input.id, `${name} id`), ns)
    ),
    list: read((ns, query: CollectionQuery | undefined) =>
      collection.list(ns, query)
    ),
    aggregate: (scope, query, options) =>
      readWithSignal(
        () => collection.aggregate(namespace(scope), query),
        options,
      ),
    search: read((ns, query: CollectionQuery) => collection.search(ns, query)),
    async create(
      scope: CollectionScope,
      input: Record<string, unknown>,
      options?: ScopedCollectionCallOptions,
    ) {
      const id = typeof input.id === "string" && input.id.trim()
        ? input.id.trim()
        : undefined;
      return (await collection.create(
        input,
        writeOptions(scope, "create", id, options),
      )).record;
    },
    async update(
      scope: CollectionScope,
      input: ScopedCollectionUpdateInput,
      options?: ScopedCollectionCallOptions,
    ) {
      const id = text(input.id, `${name} id`);
      return (await collection.update(id, {
        set: input.set,
        unset: input.unset,
      }, writeOptions(scope, "update", id, options))).record;
    },
    async delete(
      scope: CollectionScope,
      input: ScopedCollectionDeleteInput,
      options?: ScopedCollectionCallOptions,
    ) {
      const id = text(input.id, `${name} id`);
      await collection.delete(id, writeOptions(scope, "delete", id, options));
      return ({ id, deleted: true as const } as const);
    },
    commands: Object.fromEntries(
      Object.keys(collection.definition.commands ?? {}).map((
        command,
      ) => [
        command,
        async (
          scope: CollectionScope,
          input: Readonly<Record<string, unknown> & { id: string }>,
          options?: ScopedCollectionCallOptions,
        ) => {
          const { id: rawId, ...value } = input;
          const id = text(rawId, `${name} id`);
          return (await collection.mutate(
            text(id, `${name} id`),
            command,
            value,
            writeOptions(scope, `command:${command}`, id, options),
          )).record;
        },
      ]),
    ),
    queries: Object.fromEntries(
      Object.keys(collection.definition.queries ?? {}).map((
        query,
      ) => [
        query,
        (
          scope: CollectionScope,
          input: Readonly<Record<string, unknown>> = {},
          options?: Pick<ScopedCollectionReadOptions, "signal">,
        ) =>
          readWithSignal(() =>
            collection.query[query](
              namespace(scope),
              { ...input },
              scope,
              options,
            ), options),
      ]),
    ),
    relations: {
      list: (
        scope: CollectionScope,
        query?: CollectionRelationQuery,
        options?: Pick<ScopedCollectionReadOptions, "signal">,
      ) =>
        readWithSignal(
          () => services.relations(namespace(scope), query),
          options,
        ),
    } as const,
  } as const);
}

function bindMethods<Args extends unknown[], Result>(
  methods: Readonly<
    Record<string, (scope: CollectionScope, ...args: Args) => Result>
  >,
  scope: CollectionScope,
): Readonly<Record<string, (...args: Args) => Result>> {
  return (Object.fromEntries(
    Object.entries(methods).map((
      [name, method],
    ) => [name, method.bind(null, scope)]),
  ));
}

/** Scope binding only: no read, write, identity, or transaction behavior. */
export function bindCollectionScope(
  base: CollectionOperations,
  context: CollectionScope,
): ScopedCollection {
  const scope = { ...context } as const;
  return ({
    definition: base.definition,
    get: base.get.bind(null, scope),
    list: base.list.bind(null, scope),
    aggregate: base.aggregate.bind(null, scope),
    search: base.search.bind(null, scope),
    create: base.create.bind(null, scope),
    update: base.update.bind(null, scope),
    delete: base.delete.bind(null, scope),
    commands: bindMethods(base.commands, scope),
    queries: bindMethods(base.queries, scope),
    relations: { list: base.relations.list.bind(null, scope) } as const,
  } as ScopedCollection);
}
