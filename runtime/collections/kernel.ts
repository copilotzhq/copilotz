import { ulid } from "../../dependencies/ulid.ts";
import type {
  CoordinatedMutationResult,
  DurableEvent,
  EventCoordinator,
  EventDispatchReport,
  EventMutationContext,
  EventStore,
  SqlExecutor,
  SqlSession,
} from "../events/index.ts";
import { eventDataRef, readEventBody, writeEventBody } from "./body.ts";
import type { CollectionDefinition } from "./definition.ts";
import { sameValue } from "./equal.ts";
import {
  loadCollectionRecord,
  projectCollectionEvent,
} from "./reducer.ts";
import { getCollectionRecord, queryCollectionRecords } from "./query.ts";
import {
  rebuildCollectionProjections,
  verifyCollectionProjections,
} from "./replay.ts";
import type {
  CollectionDurableEvent,
  CollectionEventBody,
  CollectionMutation,
  CollectionMutationIdentity,
  CollectionQuery,
  CollectionRecord,
  CollectionUpdatePatch,
  CollectionWrite,
  CollectionWriteOptions,
} from "./types.ts";
import { validateCollectionRecord } from "./validate.ts";

export type CreateCollectionRuntimeOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlSession;
  eventStore: EventStore;
  createId?: () => string;
  now?: () => Date;
}>;

export type BoundCollectionQuery<TSelect extends object> =
  & ((
    namespace: string,
    query?: CollectionQuery,
  ) => Promise<readonly TSelect[]>)
  & Readonly<
    Record<
      string,
      (
        namespace: string,
        input?: Record<string, unknown>,
      ) => Promise<readonly TSelect[]>
    >
  >;

export type BoundCollection<
  TSelect extends CollectionRecord = CollectionRecord,
  TInsert extends object = Record<string, unknown>,
> = Readonly<{
  definition: CollectionDefinition;
  create(
    input: TInsert,
    options: CollectionWriteOptions,
  ): Promise<CollectionMutation<TSelect>>;
  update(
    id: string,
    patch: CollectionUpdatePatch<TSelect>,
    options: CollectionWriteOptions,
  ): Promise<CollectionWrite<TSelect>>;
  delete(
    id: string,
    options: CollectionWriteOptions,
  ): Promise<CollectionMutation<TSelect>>;
  mutate(
    id: string,
    command: string,
    input: unknown,
    options: CollectionWriteOptions,
  ): Promise<CollectionWrite<TSelect>>;
  get(id: string, namespace: string): Promise<TSelect | null>;
  list(namespace: string, query?: CollectionQuery): Promise<readonly TSelect[]>;
  query: BoundCollectionQuery<TSelect>;
  search(namespace: string, query: CollectionQuery): Promise<readonly TSelect[]>;
}>;

export type CollectionTransactionCollections = Readonly<
  Record<string, BoundCollection>
>;

export type CollectionTransactionOptions<T> = Readonly<{
  operationKey: string;
  namespace: string;
  identity?: CollectionMutationIdentity;
  execute(
    context: Readonly<{ collections: CollectionTransactionCollections }>,
  ): Promise<T>;
}>;

export type CollectionTransactionResult<T> = Readonly<{
  value: T;
  operationKey: string;
  namespace: string;
  settlementScopeId: string;
  correlationId: string;
  writes: readonly CollectionWrite<CollectionRecord>[];
  dispatch: EventDispatchReport;
}>;

export type CollectionRuntime = Readonly<{
  bind<
    TSelect extends CollectionRecord = CollectionRecord,
    TInsert extends object = Record<string, unknown>,
  >(
    definition: CollectionDefinition,
  ): BoundCollection<TSelect, TInsert>;
  get<
    TSelect extends CollectionRecord = CollectionRecord,
    TInsert extends object = Record<string, unknown>,
  >(
    name: string,
  ): BoundCollection<TSelect, TInsert> | undefined;
  transaction<T>(
    options: CollectionTransactionOptions<T>,
  ): Promise<CollectionTransactionResult<T>>;
  verify(
    definition: CollectionDefinition,
    namespace: string,
  ): Promise<Readonly<{ ok: true } | { ok: false; reason: string }>>;
  rebuild(
    definition: CollectionDefinition,
    namespace: string,
  ): Promise<void>;
}>;

const activeTransactions = new WeakMap<
  CollectionRuntime,
  () => SqlExecutor | undefined
>();

/** Internal bridge for capabilities that must join a collection transaction. */
export function activeCollectionTransaction(
  runtime: CollectionRuntime,
): SqlExecutor | undefined {
  return activeTransactions.get(runtime)?.();
}

type PreparedWrite = Readonly<{
  body: CollectionEventBody<CollectionRecord>;
  record: CollectionRecord;
}>;

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function applyPatch(
  current: Record<string, unknown>,
  patch: CollectionUpdatePatch<Record<string, unknown>>,
): Record<string, unknown> {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    next[key] = value as unknown;
  }
  for (const key of patch.unset ?? []) {
    delete next[key];
  }
  return next;
}

function stamp(
  value: Record<string, unknown>,
  options: Readonly<{
    namespace: string;
    id: string;
    createdAt: string;
    updatedAt: string;
    timestamps: Readonly<{ createdAt?: string; updatedAt?: string }>;
    created: boolean;
  }>,
): Record<string, unknown> {
  const createdKey = options.timestamps.createdAt ?? "createdAt";
  const updatedKey = options.timestamps.updatedAt ?? "updatedAt";
  return {
    ...value,
    id: options.id,
    namespace: options.namespace,
    ...(options.created || value[createdKey] === undefined
      ? { [createdKey]: options.createdAt }
      : {}),
    [updatedKey]: options.updatedAt,
  };
}

function applyStaticDefaults(
  definition: CollectionDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...input };
  for (const [key, value] of Object.entries(definition.defaults ?? {})) {
    if (next[key] === undefined) next[key] = structuredClone(value);
  }
  return next;
}

function envelopeFrom(
  writeOptions: CollectionWriteOptions,
  record: CollectionRecord | undefined,
  collectionName: string,
): CollectionWriteOptions {
  const threadId = writeOptions.threadId?.trim() ||
    (typeof record?.threadId === "string" ? record.threadId.trim() : "") ||
    (collectionName === "thread" && record?.id ? String(record.id) : "");
  const senderId = typeof record?.senderId === "string"
    ? record.senderId.trim()
    : "";
  const recipientIds = Array.isArray(record?.recipientIds)
    ? record.recipientIds.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    )
    : [];
  const routing = writeOptions.routing ?? (
    senderId || recipientIds.length
      ? {
        ...(senderId ? { senderId } : {}),
        ...(recipientIds.length ? { recipientIds } : {}),
      }
      : undefined
  );
  return {
    ...writeOptions,
    ...(threadId ? { threadId } : {}),
    ...(routing ? { routing } : {}),
  };
}

function canonicalEvent(event: DurableEvent): CollectionDurableEvent {
  return Object.freeze({
    id: event.id,
    position: event.position,
    schemaVersion: event.schemaVersion,
    eventType: event.type,
    namespace: event.namespace,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.subject ? { subject: event.subject } : {}),
    routing: event.routing,
    visibility: event.visibility,
    metadata: event.metadata,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    correlationId: event.correlationId,
    ...(event.deduplicationId ? { deduplicationId: event.deduplicationId } : {}),
    dataRef: eventDataRef(event.payload),
    createdAt: event.createdAt,
  });
}

function noopError(record: CollectionRecord): Error {
  return Object.assign(new Error("collection_noop"), {
    name: "CollectionNoop",
    record,
  });
}

function isNoopError(
  error: unknown,
): error is Error & { record: CollectionRecord } {
  return error instanceof Error && error.name === "CollectionNoop" &&
    "record" in error;
}

function mutationResult<TSelect extends object>(
  record: CollectionRecord,
  event: DurableEvent,
  settlementScopeId: string,
  deliveries: CollectionMutation<TSelect>["deliveries"],
  dispatch: CollectionMutation<TSelect>["dispatch"],
  deduplicated: boolean,
): CollectionMutation<TSelect> {
  return Object.freeze({
    record: deepFreeze(structuredClone(record)) as TSelect,
    event: canonicalEvent(event),
    settlementScopeId,
    deliveries,
    dispatch,
    deduplicated,
  });
}

/** Binds canonical collection commands to the existing event coordinator. */
export function createCollectionRuntime(
  options: CreateCollectionRuntimeOptions,
): CollectionRuntime {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const tables = options.eventStore.tables;
  const bound = new Map<string, BoundCollection>();
  const stack: Array<{
    operationKey: string;
    namespace: string;
    settlementScopeId: string;
    correlationId: string;
    causationId?: string;
    metadata: Record<string, unknown>;
    transaction: SqlExecutor;
    writes: CollectionWrite<CollectionRecord>[];
    pending: CoordinatedMutationResult<CollectionRecord>[];
  }> = [];
  const emptyDispatch: EventDispatchReport = Object.freeze({
    handles: Object.freeze([]),
    failures: Object.freeze([]),
  });

  const activeScope = () => stack.at(-1);

  const executor = (): SqlExecutor =>
    activeScope()?.transaction ?? options.session;

  const rememberWrite = <TWrite extends CollectionWrite<CollectionRecord>>(
    write: TWrite,
  ): TWrite => {
    const scope = activeScope();
    if (!scope) return write;
    if (Object.isFrozen(scope.writes) || !Object.isExtensible(scope.writes)) {
      scope.writes = [...scope.writes];
    }
    scope.writes.push(write);
    return write;
  };

  const scopedWriteOptions = (
    writeOptions: CollectionWriteOptions,
    collectionName: string,
    operation: string,
    subjectId: string,
  ): CollectionWriteOptions => {
    const scope = activeScope();
    const namespace = requireText(writeOptions.namespace, "Namespace");
    if (scope && namespace !== scope.namespace) {
      throw new TypeError(
        `Collection write namespace '${namespace}' does not match transaction namespace '${scope.namespace}'.`,
      );
    }
    if (!scope) return writeOptions;
    const inherited = writeOptions.identity;
    return {
      namespace,
      ...(writeOptions.threadId ? { threadId: writeOptions.threadId } : {}),
      ...(writeOptions.routing ? { routing: writeOptions.routing } : {}),
      ...(writeOptions.visibility ? { visibility: writeOptions.visibility } : {}),
      identity: {
        settlementScopeId: inherited?.settlementScopeId ??
          scope.settlementScopeId,
        correlationId: inherited?.correlationId ?? scope.correlationId,
        ...(inherited?.causationId ?? scope.causationId
          ? { causationId: inherited?.causationId ?? scope.causationId }
          : {}),
        deduplicationId: inherited?.deduplicationId ??
          `${scope.operationKey}:${collectionName}:${operation}:${subjectId}`,
        metadata: { ...scope.metadata, ...inherited?.metadata },
      },
    };
  };

  const bind = <
    TSelect extends CollectionRecord = CollectionRecord,
    TInsert extends object = Record<string, unknown>,
  >(
    definition: CollectionDefinition,
  ): BoundCollection<TSelect, TInsert> => {
    if (bound.has(definition.name)) {
      throw new TypeError(`Collection '${definition.name}' is already bound.`);
    }
    const name = definition.name;
    const timestamps = definition.timestamps ?? {
      createdAt: "createdAt",
      updatedAt: "updatedAt",
    };
    const createdAtKey = timestamps.createdAt ?? "createdAt";
    const updatedAtKey = timestamps.updatedAt ?? "updatedAt";

    const commit = async (
      eventType: string,
      subjectId: string,
      operation: string,
      writeOptions: CollectionWriteOptions,
      prepare: (context: EventMutationContext) => Promise<PreparedWrite>,
      matchData?: unknown,
    ): Promise<CollectionMutation<TSelect>> => {
      const scoped = scopedWriteOptions(
        writeOptions,
        name,
        operation,
        subjectId,
      );
      const scope = activeScope();
      const identity = scoped.identity;
      const dedup = identity?.deduplicationId?.trim();
      const bodyId = dedup
        ? `event-body:${scoped.namespace}:${dedup}`
        : createId();
      const draft = {
        type: eventType,
        namespace: scoped.namespace,
        subject: { type: name, id: subjectId },
        payload: {
          dataRef: {
            assetId: bodyId,
            kind: "json" as const,
            role: "body",
            mediaType: "application/json",
          },
        },
        metadata: structuredClone(identity?.metadata ?? {}),
        causationId: identity?.causationId,
        correlationId: identity?.correlationId,
        deduplicationId: identity?.deduplicationId,
        settlementScopeId: identity?.settlementScopeId,
        ...(scoped.threadId ? { threadId: scoped.threadId } : {}),
        ...(scoped.routing ? { routing: scoped.routing } : {}),
        ...(scoped.visibility ? { visibility: scoped.visibility } : {}),
      };
      const result = await options.coordinator.commitMutation({
        draft,
        transaction: scope?.transaction,
        dispatch: scope ? false : true,
        ...(matchData === undefined ? {} : { matchData }),
        mutate: async (context) => {
          const prepared = await prepare(context);
          await writeEventBody(context, {
            namespace: scoped.namespace,
            id: bodyId,
            json: prepared.body,
          });
          await projectCollectionEvent(context, definition, prepared.body);
          return prepared.record;
        },
        recoverDuplicate: async (event, context) => {
          const existingId = event.subject?.id;
          if (!existingId) {
            throw new Error(`Deduplicated ${name} event is missing a subject.`);
          }
          const record = await loadCollectionRecord(
            context.transaction,
            tables,
            event.namespace,
            name,
            existingId,
          );
          if (!record) {
            throw new Error(`Deduplicated ${name} '${existingId}' is missing.`);
          }
          return record;
        },
      });
      if (scope && !result.deduplicated) {
        scope.pending.push(
          result as CoordinatedMutationResult<CollectionRecord>,
        );
      }
      return rememberWrite(
        mutationResult(
          result.value as CollectionRecord,
          result.event,
          result.settlementScopeId,
          result.deliveries,
          result.dispatch,
          result.deduplicated,
        ),
      );
    };

    const existingEnvelope = async (
      id: string,
      namespace: string,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionWriteOptions> => {
      const current = await loadCollectionRecord(
        executor(),
        tables,
        namespace,
        name,
        id,
      );
      return envelopeFrom(writeOptions, current ?? undefined, name);
    };

    const create = async (
      input: TInsert,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionMutation<TSelect>> => {
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const timestamp = now().toISOString();
      const seeded = applyStaticDefaults(definition, asRecord(input));
      const id = requireText(String(seeded.id ?? createId()), `${name} id`);
      let record = stamp(seeded, {
        namespace,
        id,
        createdAt: timestamp,
        updatedAt: timestamp,
        timestamps,
        created: true,
      });
      if (definition.beforeCreate) {
        record = stamp(definition.beforeCreate(record, { namespace }), {
          namespace,
          id,
          createdAt: String(record[createdAtKey]),
          updatedAt: timestamp,
          timestamps,
          created: true,
        });
      }
      validateCollectionRecord(
        definition.schema as object,
        record,
        `${name} create`,
      );
      const frozen = deepFreeze(structuredClone(record)) as CollectionRecord;
      const body = { operation: "create" as const, record: frozen };
      return await commit(
        `${name}.created`,
        id,
        "create",
        envelopeFrom(writeOptions, frozen, name),
        () => Promise.resolve({
          body,
          record: frozen,
        }),
        body,
      );
    };

    const prepareUpdate = (
      current: CollectionRecord,
      patch: CollectionUpdatePatch<TSelect>,
      label: string,
    ): PreparedWrite => {
      const timestamp = now().toISOString();
      let next = applyPatch(
        current,
        patch as CollectionUpdatePatch<Record<string, unknown>>,
      );
      next = stamp(next, {
        namespace: current.namespace,
        id: current.id,
        createdAt: String(current[createdAtKey]),
        updatedAt: timestamp,
        timestamps,
        created: false,
      });
      if (definition.beforeUpdate && label === "update") {
        next = stamp(definition.beforeUpdate(next, {
          namespace: current.namespace,
        }), {
          namespace: current.namespace,
          id: current.id,
          createdAt: String(current[createdAtKey]),
          updatedAt: timestamp,
          timestamps,
          created: false,
        });
      }
      const comparable = {
        ...current,
        [updatedAtKey]: next[updatedAtKey],
      };
      if (sameValue(comparable, next)) throw noopError(current);
      validateCollectionRecord(
        definition.schema as object,
        next,
        `${name} ${label}`,
      );
      const frozen = deepFreeze(structuredClone(next)) as CollectionRecord;
      return {
        body: {
          operation: "update",
          id: current.id,
          set: { ...(patch.set ?? {}) } as Partial<CollectionRecord>,
          unset: Object.freeze([...(patch.unset ?? [])]),
          record: frozen,
        },
        record: frozen,
      };
    };

    const update = async (
      idInput: string,
      patch: CollectionUpdatePatch<TSelect>,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionWrite<TSelect>> => {
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} id`);
      try {
        const preview = await loadCollectionRecord(
          executor(),
          tables,
          namespace,
          name,
          id,
        );
        if (!preview) throw new Error(`Unknown ${name} '${id}'.`);
        const matchData = prepareUpdate(preview, patch, "update").body;
        return await commit(
          `${name}.updated`,
          id,
          "update",
          await existingEnvelope(id, namespace, writeOptions),
          async (context) => {
            const current = await loadCollectionRecord(
              context.transaction,
              tables,
              namespace,
              name,
              id,
              true,
            );
            if (!current) throw new Error(`Unknown ${name} '${id}'.`);
            return prepareUpdate(current, patch, "update");
          },
          matchData,
        );
      } catch (error) {
        if (isNoopError(error)) {
          return rememberWrite(Object.freeze({
            record: error.record as TSelect,
            noop: true as const,
          }));
        }
        throw error;
      }
    };

    const remove = async (
      idInput: string,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionMutation<TSelect>> => {
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} id`);
      return await commit(
        `${name}.deleted`,
        id,
        "delete",
        await existingEnvelope(id, namespace, writeOptions),
        async (context) => {
          const current = await loadCollectionRecord(
            context.transaction,
            tables,
            namespace,
            name,
            id,
            true,
          );
          if (!current) throw new Error(`Unknown ${name} '${id}'.`);
          definition.beforeDelete?.(current, { namespace });
          return {
            body: { operation: "delete", id, record: current },
            record: current,
          };
        },
      );
    };

    const mutate = async (
      idInput: string,
      commandInput: string,
      input: unknown,
      writeOptions: CollectionWriteOptions,
    ): Promise<CollectionWrite<TSelect>> => {
      const command = requireText(commandInput, `${name} command`);
      const definitionCommand = definition.commands?.[command];
      if (!definitionCommand) {
        throw new Error(`Unknown ${name} command '${command}'.`);
      }
      if (definitionCommand.input && typeof definitionCommand.input === "object") {
        validateCollectionRecord(
          definitionCommand.input,
          asRecord(input),
          `${name}.${command} input`,
        );
      }
      const namespace = requireText(writeOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} id`);
      const applyCommand = (current: CollectionRecord): PreparedWrite => {
        const patch = definitionCommand.mutate({
          current: deepFreeze(structuredClone(current)),
          input,
        });
        if (!patch) throw noopError(current);
        return prepareUpdate(
          current,
          patch as CollectionUpdatePatch<TSelect>,
          "mutate",
        );
      };
      try {
        const preview = await loadCollectionRecord(
          executor(),
          tables,
          namespace,
          name,
          id,
        );
        if (!preview) throw new Error(`Unknown ${name} '${id}'.`);
        const matchData = applyCommand(preview).body;
        return await commit(
          `${name}.updated`,
          id,
          `mutate:${command}`,
          await existingEnvelope(id, namespace, writeOptions),
          async (context) => {
            const current = await loadCollectionRecord(
              context.transaction,
              tables,
              namespace,
              name,
              id,
              true,
            );
            if (!current) throw new Error(`Unknown ${name} '${id}'.`);
            return applyCommand(current);
          },
          matchData,
        );
      } catch (error) {
        if (isNoopError(error)) {
          return rememberWrite(Object.freeze({
            record: error.record as TSelect,
            noop: true as const,
          }));
        }
        throw error;
      }
    };

    const read = (id: string, namespace: string) =>
      getCollectionRecord(
        executor(),
        tables,
        requireText(namespace, "Namespace"),
        name,
        requireText(id, `${name} id`),
      ) as Promise<TSelect | null>;

    const list = (namespace: string, query?: CollectionQuery) =>
      queryCollectionRecords(
        executor(),
        tables,
        definition,
        requireText(namespace, "Namespace"),
        query,
      ) as Promise<readonly TSelect[]>;

    const namedQueries = Object.fromEntries(
      Object.entries(definition.queries ?? {}).map(([queryName, spec]) => [
        queryName,
        (namespace: string, input: Record<string, unknown> = {}) =>
          list(namespace, { where: spec.filter({ input: asRecord(input) }) }),
      ]),
    );

    const query = Object.assign(list, namedQueries) as BoundCollectionQuery<
      TSelect
    >;

    const collection = Object.freeze({
      definition,
      create,
      update,
      delete: remove,
      mutate,
      get: read,
      list,
      query,
      search: (namespace: string, queryInput: CollectionQuery) =>
        list(namespace, { ...queryInput, text: queryInput.text ?? "" }),
      ...namedQueries,
    }) as BoundCollection<TSelect, TInsert>;
    bound.set(definition.name, collection as BoundCollection);
    return collection;
  };

  const transaction = async <T>(
    input: CollectionTransactionOptions<T>,
  ): Promise<CollectionTransactionResult<T>> => {
    const parent = stack.at(-1);
    const operationKey = requireText(input.operationKey, "Operation key");
    const namespace = requireText(input.namespace, "Namespace");
    if (parent && namespace !== parent.namespace) {
      throw new TypeError(
        `Nested transaction namespace '${namespace}' does not match '${parent.namespace}'.`,
      );
    }
    const composedKey = parent
      ? `${parent.operationKey}/${operationKey}`
      : operationKey;
    const collections = Object.freeze(Object.fromEntries(bound));

    const run = async (
      scope: (typeof stack)[number],
    ): Promise<T> => {
      stack.push(scope);
      try {
        return await input.execute({ collections });
      } finally {
        stack.pop();
      }
    };

    if (parent) {
      const start = parent.writes.length;
      const value = await run({ ...parent, operationKey: composedKey });
      return Object.freeze({
        value,
        operationKey: composedKey,
        namespace,
        settlementScopeId: parent.settlementScopeId,
        correlationId: parent.correlationId,
        writes: Object.freeze(parent.writes.slice(start)),
        dispatch: emptyDispatch,
      });
    }

    const writes: CollectionWrite<CollectionRecord>[] = [];
    const pending: CoordinatedMutationResult<CollectionRecord>[] = [];
    const settlementScopeId = input.identity?.settlementScopeId?.trim() ||
      `scope:${namespace}:${composedKey}`;
    const correlationId = input.identity?.correlationId?.trim() ||
      settlementScopeId;
    const value = await options.session.transaction(async (tx) => {
      return await run({
        operationKey: composedKey,
        namespace,
        settlementScopeId,
        correlationId,
        causationId: input.identity?.causationId,
        metadata: { ...(input.identity?.metadata ?? {}) },
        transaction: tx,
        writes,
        pending,
      });
    });

    const reports: EventDispatchReport[] = [];
    for (const committed of pending) {
      reports.push(await options.coordinator.flushCommitted(committed));
    }
    return Object.freeze({
      value,
      operationKey: composedKey,
      namespace,
      settlementScopeId,
      correlationId,
      writes: Object.freeze(writes.slice()),
      dispatch: Object.freeze({
        handles: Object.freeze(reports.flatMap((item) => [...item.handles])),
        failures: Object.freeze(reports.flatMap((item) => [...item.failures])),
      }),
    });
  };

  const runtime: CollectionRuntime = Object.freeze({
    bind,
    get: <
      TSelect extends CollectionRecord = CollectionRecord,
      TInsert extends object = Record<string, unknown>,
    >(name: string) => bound.get(name) as BoundCollection<TSelect, TInsert> | undefined,
    transaction,
    verify: (definition, namespace) =>
      verifyCollectionProjections(
        options.session,
        options.eventStore,
        definition,
        namespace,
      ),
    rebuild: (definition, namespace) =>
      rebuildCollectionProjections(
        options.session,
        options.eventStore,
        definition,
        namespace,
      ),
  });
  activeTransactions.set(runtime, () => activeScope()?.transaction);
  return runtime;
}

export async function resolveCollectionEventBody<
  TRecord = CollectionRecord,
>(
  session: SqlExecutor,
  store: EventStore,
  event: CollectionDurableEvent,
): Promise<CollectionEventBody<TRecord>> {
  return await readEventBody<CollectionEventBody<TRecord>>(
    { transaction: session, tables: store.tables },
    event.namespace,
    event.dataRef,
  );
}
