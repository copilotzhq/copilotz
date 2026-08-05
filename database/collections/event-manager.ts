import { Ajv } from "ajv";
import { ulid } from "ulid";
import type { DurableEvent, DurableEventDraft } from "@/events/types.ts";
import type {
  CollectionCrud,
  CollectionDefinition,
  CollectionPage,
  CollectionsManager,
  PageOptions,
  QueryOptions,
  ScopedCollectionCrud,
  ScopedCollectionsManager,
  WhereFilter,
  WhereOperators,
} from "./types.ts";
import type {
  CommitMutationResult,
  EventStore,
} from "@/database/event-store.ts";
import type { SqlTransaction } from "@/database/session.ts";

interface NodeRow extends Record<string, unknown> {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: Record<string, unknown> | null;
  embedding: number[] | null;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface CollectionMutationScope {
  causationId?: string;
  correlationId?: string;
  /** Stable delivery key used to deduplicate at-least-once retries. */
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
}

export interface EventCollectionsOptions {
  validateOnWrite?: boolean;
  resolveConsumers(event: DurableEvent): readonly string[];
  committed(result: CommitMutationResult<unknown>): void | Promise<void>;
}

interface ScopedState {
  namespace: string;
  scope?: CollectionMutationScope;
  operationSequence: number;
}

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function fromNode<T>(row: NodeRow): T {
  return {
    ...(row.data ?? {}),
    id: row.id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } as T;
}

function getPath(value: unknown, path: string): unknown {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function compareOperator(
  value: unknown,
  operator: string,
  expected: unknown,
): boolean {
  switch (operator) {
    case "$eq":
      return Object.is(value, expected);
    case "$ne":
      return !Object.is(value, expected);
    case "$in":
      return Array.isArray(expected) && expected.includes(value);
    case "$nin":
      return Array.isArray(expected) && !expected.includes(value);
    case "$gt":
      return (value as never) > (expected as never);
    case "$gte":
      return (value as never) >= (expected as never);
    case "$lt":
      return (value as never) < (expected as never);
    case "$lte":
      return (value as never) <= (expected as never);
    case "$contains":
      return Array.isArray(value)
        ? value.includes(expected)
        : typeof value === "string" && typeof expected === "string" &&
          value.includes(expected);
    case "$containsAll":
      return Array.isArray(value) && Array.isArray(expected) &&
        expected.every((entry) => value.includes(entry));
    case "$containsAny":
      return Array.isArray(value) && Array.isArray(expected) &&
        expected.some((entry) => value.includes(entry));
    case "$like":
    case "$ilike": {
      if (typeof value !== "string" || typeof expected !== "string") {
        return false;
      }
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replaceAll("%", ".*").replaceAll("_", ".");
      return new RegExp(`^${escaped}$`, operator === "$ilike" ? "i" : "")
        .test(value);
    }
    case "$regex":
      return typeof value === "string" && typeof expected === "string" &&
        new RegExp(expected).test(value);
    case "$startsWith":
      return typeof value === "string" && typeof expected === "string" &&
        value.startsWith(expected);
    case "$endsWith":
      return typeof value === "string" && typeof expected === "string" &&
        value.endsWith(expected);
    case "$isNull":
      return expected ? value == null : value != null;
    case "$hasKey":
      return Boolean(
        value && typeof value === "object" &&
          typeof expected === "string" && expected in value,
      );
    default:
      return false;
  }
}

function matches<T>(record: T, filter: WhereFilter<T> | undefined): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;
  const raw = filter as Record<string, unknown>;
  if (
    Array.isArray(raw.$and) &&
    !raw.$and.every((entry) => matches(record, entry))
  ) {
    return false;
  }
  if (
    Array.isArray(raw.$or) && !raw.$or.some((entry) => matches(record, entry))
  ) {
    return false;
  }
  if (raw.$not && matches(record, raw.$not as WhereFilter<T>)) return false;

  for (const [field, expected] of Object.entries(raw)) {
    if (field.startsWith("$")) continue;
    const actual = getPath(record, field);
    if (
      expected && typeof expected === "object" && !Array.isArray(expected) &&
      Object.keys(expected).some((key) => key.startsWith("$"))
    ) {
      for (
        const [operator, operand] of Object.entries(
          expected as WhereOperators<unknown>,
        )
      ) {
        if (!compareOperator(actual, operator, operand)) return false;
      }
    } else if (!Object.is(actual, expected)) {
      return false;
    }
  }
  return true;
}

function sortRecords<T>(records: T[], sort: QueryOptions<T>["sort"]): T[] {
  if (!sort?.length) return records;
  return records.sort((left, right) => {
    for (const [field, direction] of sort) {
      const a = getPath(left, String(field));
      const b = getPath(right, String(field));
      if (Object.is(a, b)) continue;
      const order = (a as never) < (b as never) ? -1 : 1;
      return direction === "desc" ? -order : order;
    }
    return 0;
  });
}

function matchableEvent(draft: DurableEventDraft): DurableEvent {
  const id = draft.deduplicationId ?? "uncommitted";
  return {
    durable: true,
    id,
    position: "0",
    schemaVersion: 2,
    type: draft.type,
    namespace: draft.namespace,
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    ...(draft.subject ? { subject: draft.subject } : {}),
    payload: draft.payload,
    ...(draft.delta === undefined ? {} : { delta: draft.delta }),
    routing: draft.routing ?? {},
    visibility: draft.visibility ?? { kind: "public" },
    metadata: draft.metadata ?? {},
    ...(draft.causationId ? { causationId: draft.causationId } : {}),
    correlationId: draft.correlationId ?? id,
    ...(draft.deduplicationId
      ? { deduplicationId: draft.deduplicationId }
      : {}),
    createdAt: draft.createdAt ?? new Date().toISOString(),
  };
}

function operationDedupe(
  state: ScopedState,
  collection: string,
  operation: string,
): string | undefined {
  if (!state.scope?.idempotencyKey) return undefined;
  const sequence = state.operationSequence++;
  return `${state.scope.idempotencyKey}:${collection}.${operation}:${sequence}`;
}

function nodeName(record: Record<string, unknown>, fallback: string): string {
  for (
    const key of ["name", "title", "externalId", "key", "messageId", "threadId"]
  ) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}

function commonThreadId(
  records: readonly Record<string, unknown>[],
): string | undefined {
  const first = records[0]?.threadId;
  if (typeof first !== "string" || !first) return undefined;
  return records.every((record) => record.threadId === first)
    ? first
    : undefined;
}

class EventCollection<TSelect, TInsert>
  implements CollectionCrud<TSelect, TInsert> {
  readonly #store: EventStore;
  readonly #definition: CollectionDefinition;
  readonly #options: EventCollectionsOptions;
  readonly #defaultState?: ScopedState;
  readonly #validate?: (value: unknown) => boolean;

  constructor(
    store: EventStore,
    definition: CollectionDefinition,
    options: EventCollectionsOptions,
    defaultState?: ScopedState,
  ) {
    this.#store = store;
    this.#definition = definition;
    this.#options = options;
    this.#defaultState = defaultState;
    if (options.validateOnWrite) {
      this.#validate = new Ajv({ allErrors: true, strict: false })
        .compile(definition.schema) as (value: unknown) => boolean;
    }
  }

  scoped(state: ScopedState): ScopedCollectionCrud<TSelect, TInsert> {
    return {
      create: (data) => this.#create(data, state),
      createMany: (data) => this.#createMany(data, state),
      find: (filter, options) =>
        this.#find(filter, { ...options, namespace: state.namespace }),
      findPage: (filter, options) =>
        this.#findPage(filter, { ...options, namespace: state.namespace }),
      findOne: (filter, options) =>
        this.#findOne(filter, { ...options, namespace: state.namespace }),
      findById: (id, options) =>
        this.findById(id, { ...options, namespace: state.namespace }),
      update: (filter, data) => this.#update(filter, data, state),
      updateMany: (filter, data) => this.#updateMany(filter, data, state),
      delete: (filter) => this.#delete(filter, state, false),
      deleteMany: (filter) => this.#delete(filter, state, true),
      upsert: (filter, data) => this.#upsert(filter, data, state),
      count: (filter) => this.count(filter, { namespace: state.namespace }),
      exists: (filter) => this.exists(filter, { namespace: state.namespace }),
    };
  }

  create(data: TInsert, options: { namespace: string }): Promise<TSelect> {
    return this.#create(data, this.#state(options.namespace));
  }

  createMany(
    data: TInsert[],
    options: { namespace: string },
  ): Promise<TSelect[]> {
    return this.#createMany(data, this.#state(options.namespace));
  }

  find(
    filter?: WhereFilter<TSelect>,
    options?: QueryOptions<TSelect>,
  ): Promise<TSelect[]> {
    return this.#find(filter, options);
  }

  findPage(
    filter?: WhereFilter<TSelect>,
    options?: PageOptions<TSelect>,
  ): Promise<CollectionPage<TSelect>> {
    return this.#findPage(filter, options);
  }

  findOne(
    filter: WhereFilter<TSelect>,
    options?: Omit<QueryOptions<TSelect>, "limit" | "offset">,
  ): Promise<TSelect | null> {
    return this.#findOne(filter, options);
  }

  async findById(
    id: string,
    options: { namespace: string; populate?: string[] },
  ): Promise<TSelect | null> {
    void options.populate;
    const result = await this.#store.read<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE id = $1 AND namespace = $2 AND type = $3 LIMIT 1`,
      [id, options.namespace, this.#definition.name],
    );
    return result.rows[0] ? fromNode<TSelect>(result.rows[0]) : null;
  }

  update(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
    options: { namespace: string },
  ): Promise<TSelect | null> {
    return this.#update(filter, data, this.#state(options.namespace));
  }

  updateMany(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
    options: { namespace: string },
  ): Promise<{ updated: number }> {
    return this.#updateMany(filter, data, this.#state(options.namespace));
  }

  delete(
    filter: WhereFilter<TSelect>,
    options: { namespace: string },
  ): Promise<{ deleted: number }> {
    return this.#delete(filter, this.#state(options.namespace), false);
  }

  deleteMany(
    filter: WhereFilter<TSelect>,
    options: { namespace: string },
  ): Promise<{ deleted: number }> {
    return this.#delete(filter, this.#state(options.namespace), true);
  }

  upsert(
    filter: WhereFilter<TSelect>,
    data: TInsert,
    options: { namespace: string },
  ): Promise<TSelect> {
    return this.#upsert(filter, data, this.#state(options.namespace));
  }

  async count(
    filter?: WhereFilter<TSelect>,
    options?: { namespace: string },
  ): Promise<number> {
    return (await this.#find(filter, options)).length;
  }

  async exists(
    filter: WhereFilter<TSelect>,
    options: { namespace: string },
  ): Promise<boolean> {
    return (await this.#findOne(filter, options)) !== null;
  }

  #state(namespace?: string): ScopedState {
    if (
      this.#defaultState &&
      (!namespace || namespace === this.#defaultState.namespace)
    ) {
      return this.#defaultState;
    }
    if (!namespace) throw new TypeError("Collection namespace is required.");
    return { namespace, operationSequence: 0 };
  }

  async #rows(namespace?: string): Promise<NodeRow[]> {
    if (!namespace) throw new TypeError("Collection namespace is required.");
    const result = await this.#store.read<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE namespace = $1 AND type = $2 ORDER BY created_at ASC, id ASC`,
      [namespace, this.#definition.name],
    );
    return result.rows;
  }

  async #find(
    filter?: WhereFilter<TSelect>,
    options?: QueryOptions<TSelect> | { namespace?: string },
  ): Promise<TSelect[]> {
    const namespace = options?.namespace ?? this.#defaultState?.namespace;
    let records = (await this.#rows(namespace)).map(fromNode<TSelect>)
      .filter((record) => matches(record, filter));
    records = sortRecords(
      records,
      (options as QueryOptions<TSelect> | undefined)?.sort,
    );
    const offset = (options as QueryOptions<TSelect> | undefined)?.offset ?? 0;
    const limit = (options as QueryOptions<TSelect> | undefined)?.limit;
    return records.slice(
      offset,
      limit === undefined ? undefined : offset + limit,
    );
  }

  async #findPage(
    filter?: WhereFilter<TSelect>,
    options?: PageOptions<TSelect>,
  ): Promise<CollectionPage<TSelect>> {
    const cursorField = String(options?.cursorField ?? "id");
    const all = await this.#find(filter, {
      ...options,
      limit: undefined,
      offset: undefined,
    });
    let start = 0;
    if (options?.after) {
      start = Math.max(
        0,
        all.findIndex((record) =>
          String(getPath(record, cursorField)) === options.after
        ) + 1,
      );
    } else if (options?.before) {
      const index = all.findIndex((record) =>
        String(getPath(record, cursorField)) === options.before
      );
      start = Math.max(0, index - (options.limit ?? 50));
    }
    const limit = options?.limit ?? 50;
    const data = all.slice(start, start + limit);
    return {
      data,
      pageInfo: {
        hasMoreBefore: start > 0,
        hasMoreAfter: start + data.length < all.length,
        startCursor: data.length ? String(getPath(data[0], cursorField)) : null,
        endCursor: data.length
          ? String(getPath(data[data.length - 1], cursorField))
          : null,
        cursorField,
      },
    };
  }

  async #findOne(
    filter: WhereFilter<TSelect>,
    options?: Omit<QueryOptions<TSelect>, "limit" | "offset"> | {
      namespace?: string;
    },
  ): Promise<TSelect | null> {
    return (await this.#find(
      filter,
      { ...options, limit: 1 } as QueryOptions<TSelect>,
    ))[0] ?? null;
  }

  async #create(data: TInsert, state: ScopedState): Promise<TSelect> {
    const values = await this.#prepareCreate(
      data as Record<string, unknown>,
      state,
    );
    const id = typeof values.id === "string" ? values.id : ulid();
    const now = new Date().toISOString();
    const record: Record<string, unknown> = {
      ...values,
      id,
      createdAt: now,
      updatedAt: now,
    };
    this.#assertValid(record);
    const draft = this.#draft("created", state, {
      subject: { type: this.#definition.name, id },
      ...(typeof record.threadId === "string"
        ? { threadId: record.threadId }
        : {}),
      payload: { record },
      delta: record,
    });
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#options.resolveConsumers(matchableEvent(draft)),
      mutate: async (transaction) => {
        await this.#insertNode(transaction, state.namespace, record);
        return record as TSelect;
      },
      onDuplicate: async (event, transaction) => {
        const committedId = event.subject?.id;
        const row = committedId
          ? await this.#nodeById(transaction, committedId, state.namespace)
          : null;
        if (!row) {
          throw new Error(
            `Deduplicated ${this.#definition.name} '${
              committedId ?? id
            }' is missing.`,
          );
        }
        return fromNode<TSelect>(row);
      },
    });
    await this.#notify(result);
    return result.value;
  }

  async #createMany(data: TInsert[], state: ScopedState): Promise<TSelect[]> {
    const now = new Date().toISOString();
    const records: Record<string, unknown>[] = [];
    for (const input of data) {
      const values = await this.#prepareCreate(
        input as Record<string, unknown>,
        state,
      );
      const id = typeof values.id === "string" ? values.id : ulid();
      const record = { ...values, id, createdAt: now, updatedAt: now };
      this.#assertValid(record);
      records.push(record);
    }
    const draft = this.#draft("created", state, {
      ...(commonThreadId(records) ? { threadId: commonThreadId(records) } : {}),
      payload: {
        ids: records.map((record) => record.id),
        count: records.length,
      },
      delta: { records },
    });
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#options.resolveConsumers(matchableEvent(draft)),
      mutate: async (transaction) => {
        for (const record of records) {
          await this.#insertNode(transaction, state.namespace, record);
        }
        return records as TSelect[];
      },
      onDuplicate: async (event, transaction) => {
        const payload = event.payload as { ids?: unknown };
        const ids = Array.isArray(payload.ids)
          ? payload.ids.filter((value): value is string =>
            typeof value === "string"
          )
          : [];
        if (!ids.length) return [];
        const rows = await transaction.query<NodeRow>(
          `SELECT * FROM ${this.#store.table("nodes")}
           WHERE namespace = $1 AND type = $2 AND id = ANY($3::text[])`,
          [state.namespace, this.#definition.name, ids],
        );
        const byId = new Map(rows.rows.map((row) => [row.id, row]));
        return ids.flatMap((id) => {
          const row = byId.get(id);
          return row ? [fromNode<TSelect>(row)] : [];
        });
      },
    });
    await this.#notify(result);
    return result.value;
  }

  async #update(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
    state: ScopedState,
  ): Promise<TSelect | null> {
    const records = await this.#find(filter, {
      namespace: state.namespace,
      limit: 1,
    });
    const current = records[0] as Record<string, unknown> | undefined;
    if (!current) return null;
    const patch = await this.#prepareUpdate(
      data as Record<string, unknown>,
      state,
    );
    const next: Record<string, unknown> = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: new Date().toISOString(),
    };
    this.#assertValid(next);
    const id = String(current.id);
    const draft = this.#draft("updated", state, {
      subject: { type: this.#definition.name, id },
      ...(typeof next.threadId === "string" ? { threadId: next.threadId } : {}),
      payload: { id, patch },
      delta: { before: current, after: next, patch },
    });
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#options.resolveConsumers(matchableEvent(draft)),
      mutate: async (transaction) => {
        await this.#replaceNodeData(transaction, id, state.namespace, next);
        return next as TSelect;
      },
      onDuplicate: async (_event, transaction) => {
        const row = await this.#nodeById(transaction, id, state.namespace);
        return row ? fromNode<TSelect>(row) : null as TSelect | null;
      },
    });
    await this.#notify(result);
    return result.value;
  }

  async #updateMany(
    filter: WhereFilter<TSelect>,
    data: Partial<TInsert>,
    state: ScopedState,
  ): Promise<{ updated: number }> {
    const current = await this.#find(filter, { namespace: state.namespace });
    if (!current.length) return { updated: 0 };
    const patch = await this.#prepareUpdate(
      data as Record<string, unknown>,
      state,
    );
    const now = new Date().toISOString();
    const next = current.map((record) => ({
      ...(record as Record<string, unknown>),
      ...patch,
      id: (record as Record<string, unknown>).id,
      updatedAt: now,
    }));
    next.forEach((record) => this.#assertValid(record));
    const ids = next.map((record) => String(record.id));
    const draft = this.#draft("updated", state, {
      ...(commonThreadId(next) ? { threadId: commonThreadId(next) } : {}),
      payload: { ids, count: ids.length, patch },
      delta: { records: next },
    });
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#options.resolveConsumers(matchableEvent(draft)),
      mutate: async (transaction) => {
        for (const record of next) {
          await this.#replaceNodeData(
            transaction,
            String(record.id),
            state.namespace,
            record,
          );
        }
        return { updated: next.length };
      },
      onDuplicate: () => Promise.resolve({ updated: next.length }),
    });
    await this.#notify(result);
    return result.value;
  }

  async #delete(
    filter: WhereFilter<TSelect>,
    state: ScopedState,
    many: boolean,
  ): Promise<{ deleted: number }> {
    await this.#definition.hooks?.beforeDelete?.(
      filter as Record<string, unknown>,
      { namespace: state.namespace },
    );
    const found = await this.#find(filter, {
      namespace: state.namespace,
      ...(many ? {} : { limit: 1 }),
    });
    if (!found.length) return { deleted: 0 };
    const ids = found.map((record) =>
      String((record as Record<string, unknown>).id)
    );
    const draft = this.#draft("deleted", state, {
      ...(ids.length === 1
        ? { subject: { type: this.#definition.name, id: ids[0] } }
        : {}),
      ...(commonThreadId(found as Record<string, unknown>[])
        ? {
          threadId: commonThreadId(found as Record<string, unknown>[]),
        }
        : {}),
      payload: { ids, count: ids.length },
      delta: { records: found },
    });
    const result = await this.#store.commitMutation({
      draft,
      consumerIds: this.#options.resolveConsumers(matchableEvent(draft)),
      mutate: async (transaction) => {
        await transaction.query(
          `DELETE FROM ${this.#store.table("nodes")}
           WHERE namespace = $1 AND type = $2 AND id = ANY($3::text[])`,
          [state.namespace, this.#definition.name, ids],
        );
        return { deleted: ids.length };
      },
      onDuplicate: () => Promise.resolve({ deleted: ids.length }),
    });
    await this.#notify(result);
    return result.value;
  }

  async #upsert(
    filter: WhereFilter<TSelect>,
    data: TInsert,
    state: ScopedState,
  ): Promise<TSelect> {
    const existing = await this.#findOne(filter, {
      namespace: state.namespace,
    });
    if (existing) {
      return (await this.#update(filter, data as Partial<TInsert>, state))!;
    }
    return await this.#create(data, state);
  }

  async #prepareCreate(
    input: Record<string, unknown>,
    state: ScopedState,
  ): Promise<Record<string, unknown>> {
    const defaults = Object.fromEntries(
      Object.entries(this.#definition.defaults ?? {}).map(([key, value]) => [
        key,
        typeof value === "function" ? value() : value,
      ]),
    );
    const value = { ...defaults, ...input };
    return await this.#definition.hooks?.beforeCreate?.(
      value,
      { namespace: state.namespace },
    ) ?? value;
  }

  async #prepareUpdate(
    input: Record<string, unknown>,
    state: ScopedState,
  ): Promise<Record<string, unknown>> {
    return await this.#definition.hooks?.beforeUpdate?.(
      input,
      { namespace: state.namespace },
    ) ?? input;
  }

  #assertValid(value: unknown): void {
    if (!this.#validate?.(value)) {
      const errors = (this.#validate as unknown as { errors?: unknown })
        ?.errors;
      throw new TypeError(
        `Invalid ${this.#definition.name} record: ${
          JSON.stringify(errors ?? "schema mismatch")
        }`,
      );
    }
  }

  #draft(
    operation: "created" | "updated" | "deleted",
    state: ScopedState,
    values: Pick<
      DurableEventDraft,
      "subject" | "payload" | "delta" | "threadId"
    >,
  ): DurableEventDraft {
    return {
      type: `${this.#definition.name}.${operation}`,
      namespace: state.namespace,
      ...values,
      visibility: { kind: "public" },
      metadata: state.scope?.metadata ?? {},
      causationId: state.scope?.causationId,
      correlationId: state.scope?.correlationId,
      deduplicationId: operationDedupe(
        state,
        this.#definition.name,
        operation,
      ),
    };
  }

  async #notify<T>(result: CommitMutationResult<T>): Promise<void> {
    if (!result.deduplicated) await this.#options.committed(result);
  }

  async #insertNode(
    transaction: SqlTransaction,
    namespace: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO ${this.#store.table("nodes")} (
        id, namespace, type, name, content, data, embedding,
        source_type, source_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9,
        $10::timestamptz, $11::timestamptz)`,
      [
        record.id,
        namespace,
        this.#definition.name,
        nodeName(record, String(record.id)),
        typeof record.content === "string" ? record.content : null,
        JSON.stringify(record),
        JSON.stringify(record.embedding ?? null),
        typeof record.sourceType === "string" ? record.sourceType : null,
        typeof record.sourceId === "string" ? record.sourceId : null,
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async #replaceNodeData(
    transaction: SqlTransaction,
    id: string,
    namespace: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    await transaction.query(
      `UPDATE ${this.#store.table("nodes")}
       SET name = $4, content = $5, data = $6::jsonb,
           embedding = $7::jsonb, source_type = $8, source_id = $9,
           updated_at = $10::timestamptz
       WHERE id = $1 AND namespace = $2 AND type = $3`,
      [
        id,
        namespace,
        this.#definition.name,
        nodeName(record, id),
        typeof record.content === "string" ? record.content : null,
        JSON.stringify(record),
        JSON.stringify(record.embedding ?? null),
        typeof record.sourceType === "string" ? record.sourceType : null,
        typeof record.sourceId === "string" ? record.sourceId : null,
        record.updatedAt,
      ],
    );
  }

  async #nodeById(
    transaction: SqlTransaction,
    id: string,
    namespace: string,
  ): Promise<NodeRow | null> {
    const result = await transaction.query<NodeRow>(
      `SELECT * FROM ${this.#store.table("nodes")}
       WHERE id = $1 AND namespace = $2 AND type = $3 LIMIT 1`,
      [id, namespace, this.#definition.name],
    );
    return result.rows[0] ?? null;
  }
}

export function createEventCollectionsManager(
  store: EventStore,
  definitions: readonly CollectionDefinition[],
  options: EventCollectionsOptions,
): CollectionsManager & {
  withMutationScope(
    namespace: string,
    scope: CollectionMutationScope,
  ): ScopedCollectionsManager;
} {
  const byName = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );
  if (byName.size !== definitions.length) {
    throw new TypeError(
      "Collection names must be unique after plugin composition.",
    );
  }
  const root: Record<string, unknown> = {};
  for (const definition of definitions) {
    root[definition.name] = new EventCollection(store, definition, options);
  }

  const scope = (
    namespace: string,
    mutationScope?: CollectionMutationScope,
  ): ScopedCollectionsManager => {
    if (!namespace.trim()) {
      throw new TypeError("Collection namespace is required.");
    }
    const state: ScopedState = {
      namespace,
      scope: mutationScope,
      operationSequence: 0,
    };
    const scoped: Record<string, unknown> = { namespace };
    for (const definition of definitions) {
      const collection = root[definition.name] as EventCollection<
        unknown,
        unknown
      >;
      const crud = collection.scoped(state) as unknown as Record<
        string,
        unknown
      >;
      if (definition.methods) {
        Object.assign(
          crud,
          definition.methods({
            collection: crud as never,
            manager: scoped,
            collections: scoped,
            rootCollections: root as never,
            namespace,
          }),
        );
      }
      scoped[definition.name] = crud;
    }
    return scoped as ScopedCollectionsManager;
  };

  return Object.assign(root, {
    definitions: Object.freeze([...definitions]),
    withNamespace: (namespace: string) => scope(namespace),
    withMutationScope: scope,
  }) as CollectionsManager & {
    withMutationScope(
      namespace: string,
      mutationScope: CollectionMutationScope,
    ): ScopedCollectionsManager;
  };
}
