import type { JsonSchema } from "../../dependencies/ominipg.ts";
import { ulid } from "../../dependencies/ulid.ts";
import type {
  ContentRef,
  ContentSequence,
  DurableContentInput,
  PreparedContent,
} from "../content/index.ts";
import type { EventMutationContext, SqlExecutor } from "../events/index.ts";
import type {
  CollectionCommandResult,
  CollectionRecord,
  CreateEventCollectionRepositoryOptions,
  EventCollectionRepository,
  EventCollectionValue,
} from "./collection-types.ts";
import type { MutationIdentity } from "./types.ts";

type NodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type RuntimeCollectionDefinition = Readonly<{
  name: string;
  defaults?: Record<string, (() => unknown) | unknown>;
  timestamps?: { createdAt?: string; updatedAt?: string };
  search?: { enabled: boolean; fields: readonly string[] };
  content?: { fields: readonly string[] };
  hooks?: Readonly<{
    beforeCreate?: (
      data: Record<string, unknown>,
      context: { namespace: string },
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    beforeUpdate?: (
      data: Record<string, unknown>,
      context: { namespace: string },
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
    beforeDelete?: (
      filter: Record<string, unknown>,
      context: { namespace: string },
    ) => void | Promise<void>;
  }>;
  commands?: Readonly<
    Record<
      string,
      Readonly<{
        execute(
          context: Readonly<{
            namespace: string;
            operationId: string;
            current: Readonly<Record<string, unknown>>;
            input: unknown;
          }>,
        ): Record<string, unknown> | Promise<Record<string, unknown>>;
      }>
    >
  >;
}>;

type ExtractedCollectionContent = Readonly<{
  input: Record<string, unknown>;
  durable: ReadonlyMap<string, DurableContentInput>;
}>;

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
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

function jsonRecord(
  value: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new TypeError(`${name} is not serializable.`);
    }
    const decoded = JSON.parse(encoded);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new TypeError(`${name} must be an object.`);
    }
    return decoded;
  } catch (cause) {
    throw new TypeError(`${name} must be JSON serializable.`, { cause });
  }
}

function mapNode<TRecord extends CollectionRecord>(row: NodeRow): TRecord {
  return deepFreeze({
    ...structuredClone(record(row.data)),
    id: row.id,
    namespace: row.namespace,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }) as TRecord;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Collection limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
}

function stableMutationId(
  collection: string,
  namespace: string,
  explicit: unknown,
  identity: MutationIdentity | undefined,
  createId: () => string,
): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (identity?.deduplicationId?.trim()) {
    return `${namespace}:${collection}:${identity.deduplicationId.trim()}`;
  }
  return createId();
}

function identityDraft(identity: MutationIdentity | undefined) {
  return {
    ...(identity?.causationId?.trim()
      ? { causationId: identity.causationId.trim() }
      : {}),
    ...(identity?.correlationId?.trim()
      ? { correlationId: identity.correlationId.trim() }
      : {}),
    ...(identity?.deduplicationId?.trim()
      ? { deduplicationId: identity.deduplicationId.trim() }
      : {}),
    ...(identity?.settlementScopeId?.trim()
      ? { settlementScopeId: identity.settlementScopeId.trim() }
      : {}),
    metadata: structuredClone(identity?.metadata ?? {}),
  };
}

function applyDefaults(
  definition: RuntimeCollectionDefinition,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...input };
  for (const [field, fallback] of Object.entries(definition.defaults ?? {})) {
    if (result[field] !== undefined) continue;
    result[field] = typeof fallback === "function" ? fallback() : fallback;
  }
  return result;
}

function applyCreateTimestamps(
  definition: RuntimeCollectionDefinition,
  input: Record<string, unknown>,
  timestamp: string,
): Record<string, unknown> {
  const result = { ...input };
  const createdField = definition.timestamps?.createdAt;
  const updatedField = definition.timestamps?.updatedAt;
  if (createdField && result[createdField] === undefined) {
    result[createdField] = timestamp;
  }
  if (updatedField && result[updatedField] === undefined) {
    result[updatedField] = timestamp;
  }
  return result;
}

function searchContent(
  definition: RuntimeCollectionDefinition,
  value: Record<string, unknown>,
): string | null {
  if (!definition.search?.enabled) return null;
  const parts = definition.search.fields.flatMap((field) => {
    const candidate = value[field];
    return typeof candidate === "string" && candidate.trim()
      ? [candidate.trim()]
      : [];
  });
  return parts.length ? parts.join("\n") : null;
}

function eventFields(value: Record<string, unknown>): readonly string[] {
  return Object.freeze(Object.keys(value).sort());
}

function configuredContentFields(
  definition: RuntimeCollectionDefinition,
): readonly string[] {
  const fields = definition.content?.fields ?? [];
  const normalized = fields.map((field) =>
    requireText(
      field,
      `Collection '${definition.name}' content field`,
    )
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(
      `Collection '${definition.name}' contains duplicate content fields.`,
    );
  }
  return Object.freeze(normalized);
}

function fieldPath(field: string): readonly string[] {
  const parts = field.split(".");
  if (
    parts.some((part) =>
      !part || part === "__proto__" || part === "prototype" ||
      part === "constructor"
    )
  ) {
    throw new TypeError(`Invalid collection content field path '${field}'.`);
  }
  return parts;
}

function nestedValue(
  input: Readonly<Record<string, unknown>>,
  field: string,
): { exists: boolean; value?: unknown } {
  let current: unknown = input;
  for (const part of fieldPath(field)) {
    if (
      !current || typeof current !== "object" || Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) return { exists: false };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function setNestedValue(
  input: Record<string, unknown>,
  field: string,
  value: unknown,
): void {
  const parts = fieldPath(field);
  let current = input;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      throw new TypeError(
        `Collection content field '${field}' has a non-object parent.`,
      );
    }
    current = child as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

function isPreparedContent(value: unknown): value is PreparedContent {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
      Array.isArray((value as PreparedContent).content) &&
      Array.isArray((value as PreparedContent).assets),
  );
}

function extractCollectionContent(
  input: Record<string, unknown>,
  fields: readonly string[],
  name: string,
): ExtractedCollectionContent {
  const normalized = structuredClone(input);
  const durable = new Map<string, DurableContentInput>();
  for (const field of fields) {
    const nested = nestedValue(input, field);
    if (!nested.exists) continue;
    const value = nested.value;
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      durable.set(field, value as ContentSequence);
      continue;
    }
    if (isPreparedContent(value)) {
      durable.set(field, value);
      setNestedValue(normalized, field, value.content);
      continue;
    }
    throw new TypeError(
      `Collection '${name}' content field '${field}' must contain canonical refs, prepared content, or null.`,
    );
  }
  return Object.freeze({ input: normalized, durable });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function canonicalizeCollectionContent(
  context: EventMutationContext,
  namespace: string,
  name: string,
  fields: readonly string[],
  value: Record<string, unknown>,
  extracted: ReadonlyMap<string, DurableContentInput>,
  assets: CreateEventCollectionRepositoryOptions["assets"],
): Promise<void> {
  if (fields.length === 0) return;
  if (!assets) {
    throw new Error(
      `Collection '${name}' declares canonical content but no asset repository is configured.`,
    );
  }
  for (const field of fields) {
    const nested = nestedValue(value, field);
    if (!nested.exists) continue;
    const current = nested.value;
    if (current === undefined || current === null) continue;
    if (!Array.isArray(current)) {
      throw new TypeError(
        `Collection '${name}' content field '${field}' must resolve to canonical refs.`,
      );
    }
    const supplied = extracted.get(field);
    const content = supplied && isPreparedContent(supplied) &&
        sameJson(current, supplied.content)
      ? supplied
      : current as ContentSequence;
    setNestedValue(
      value,
      field,
      await assets.materialize(context, {
        namespace,
        content,
        origin: {
          scope: {
            type: "collection",
            collection: name,
            id: String(value.id),
          },
          producer: { type: name, id: String(value.id) },
        },
      }),
    );
  }
}

function ownedContent(
  value: Record<string, unknown>,
  fields: readonly string[],
): ContentSequence {
  return Object.freeze(fields.flatMap((field) => {
    const candidate = nestedValue(value, field).value;
    return Array.isArray(candidate) ? candidate as ContentRef[] : [];
  }));
}

function edgeId(
  namespace: string,
  type: string,
  sourceId: string,
  targetId: string,
): string {
  return `relation:${JSON.stringify([namespace, type, sourceId, targetId])}`;
}

function assertDefinition(definition: RuntimeCollectionDefinition): string {
  const name = requireText(definition.name, "Collection name");
  if (!/^[a-z][a-z0-9_.-]*$/i.test(name)) {
    throw new TypeError(`Collection name '${name}' cannot form an event type.`);
  }
  return name;
}

/** Creates event-native typed mutations for one graph collection resource. */
export function createEventCollectionRepository<
  S extends JsonSchema,
  TSelect extends object,
  TInsert extends object,
>(
  options: CreateEventCollectionRepositoryOptions<S, TSelect, TInsert>,
): EventCollectionRepository<S, TSelect, TInsert> {
  const { definition, coordinator, session } = options;
  const tables = options.eventStore.tables;
  const name = assertDefinition(definition);
  const contentFields = configuredContentFields(definition);
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());

  const findNode = async (
    executor: SqlExecutor,
    namespace: string,
    id: string,
    lock = false,
  ): Promise<NodeRow | null> => {
    const result = await executor.query<NodeRow>(
      `SELECT * FROM ${tables.nodes}
       WHERE namespace = $1 AND id = $2 AND type = $3
       LIMIT 1${lock ? " FOR UPDATE" : ""}`,
      [namespace, id, name],
    );
    return result.rows[0] ?? null;
  };

  const requireNode = async (
    executor: SqlExecutor,
    namespace: string,
    id: string,
    lock = false,
  ): Promise<NodeRow> => {
    const row = await findNode(executor, namespace, id, lock);
    if (!row) throw new Error(`Unknown ${name} '${id}' in '${namespace}'.`);
    return row;
  };

  const synchronizeRelations = async (
    transaction: SqlExecutor,
    namespace: string,
    childId: string,
    value: Record<string, unknown>,
  ): Promise<void> => {
    for (
      const [relationName, relation] of Object.entries(
        definition.relations ?? {},
      )
    ) {
      if (relation.type !== "belongsTo") continue;
      const type = relation.edgeType ?? `has_${name}`;
      await transaction.query(
        `DELETE FROM ${tables.edges}
         WHERE namespace = $1 AND target_node_id = $2 AND type = $3`,
        [namespace, childId, type],
      );
      const rawParentId = value[relation.foreignKey];
      if (
        rawParentId === null || rawParentId === undefined || rawParentId === ""
      ) {
        continue;
      }
      const parentId = requireText(
        String(rawParentId),
        `Relation '${relationName}' foreign key`,
      );
      const parent = await transaction.query<{ id: string }>(
        `SELECT id FROM ${tables.nodes}
         WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
        [namespace, parentId, relation.collection],
      );
      if (!parent.rows[0]) {
        throw new Error(
          `Relation '${relationName}' references missing ${relation.collection} '${parentId}'.`,
        );
      }
      await transaction.query(
        `INSERT INTO ${tables.edges} (
           id, namespace, source_node_id, target_node_id, type, data, weight
         ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 1)
         ON CONFLICT (id) DO NOTHING`,
        [
          edgeId(namespace, type, parentId, childId),
          namespace,
          parentId,
          childId,
          type,
        ],
      );
    }
  };

  const validate = async (
    operation: "create" | "update",
    value: Record<string, unknown>,
  ): Promise<void> => {
    await options.validate?.({
      definition,
      operation,
      record: deepFreeze(structuredClone(value)),
    });
  };

  const repository: EventCollectionRepository<S, TSelect, TInsert> = {
    definition,
    create(input, mutationOptions) {
      const namespace = requireText(mutationOptions.namespace, "Namespace");
      const timestamp = now().toISOString();
      const extractedContent = extractCollectionContent(
        input as Record<string, unknown>,
        contentFields,
        name,
      );
      const seeded = applyCreateTimestamps(
        definition,
        applyDefaults(
          definition,
          jsonRecord(extractedContent.input, `${name} input`),
        ),
        timestamp,
      );
      const id = stableMutationId(
        name,
        namespace,
        seeded.id,
        mutationOptions.identity,
        createId,
      );
      seeded.id = id;
      return coordinator.commitMutation({
        draft: {
          type: `${name}.created`,
          namespace,
          subject: { type: name, id },
          payload: { id },
          delta: { fields: eventFields(seeded) },
          ...identityDraft(mutationOptions.identity),
        },
        mutate: async (context) => {
          const { transaction } = context;
          let processed = seeded;
          if (definition.hooks?.beforeCreate) {
            processed = await definition.hooks.beforeCreate(
              structuredClone(seeded),
              { namespace },
            );
          }
          processed = jsonRecord(processed, `${name} beforeCreate result`);
          if (processed.id !== id) {
            throw new TypeError(
              `Collection '${name}' beforeCreate cannot change id.`,
            );
          }
          await canonicalizeCollectionContent(
            context,
            namespace,
            name,
            contentFields,
            processed,
            extractedContent.durable,
            options.assets,
          );
          await validate("create", processed);
          const primaryKey = definition.keys?.[0]?.property ?? "id";
          const sourceId = processed[primaryKey];
          const inserted = await transaction.query<NodeRow>(
            `INSERT INTO ${tables.nodes} (
               id, namespace, type, name, content, data, source_type, source_id
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
             RETURNING *`,
            [
              id,
              namespace,
              name,
              String(processed.name ?? id),
              searchContent(definition, processed),
              JSON.stringify(processed),
              primaryKey === "id" ? null : `${name}:${primaryKey}`,
              primaryKey === "id" || sourceId == null ? null : String(sourceId),
            ],
          );
          await synchronizeRelations(transaction, namespace, id, processed);
          if (contentFields.length > 0) {
            await options.assets!.linkOwner(context, {
              namespace,
              ownerId: id,
              content: ownedContent(processed, contentFields),
            });
          }
          return mapNode<EventCollectionValue<TSelect>>(inserted.rows[0]);
        },
        recoverDuplicate: async (_event, { transaction }) =>
          mapNode<EventCollectionValue<TSelect>>(
            await requireNode(transaction, namespace, id),
          ),
      });
    },
    update(idInput, patchInput, mutationOptions) {
      const namespace = requireText(mutationOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} ID`);
      const extractedContent = extractCollectionContent(
        patchInput as Record<string, unknown>,
        contentFields,
        name,
      );
      const patch = jsonRecord(
        extractedContent.input,
        `${name} patch`,
      );
      if (patch.id !== undefined && patch.id !== id) {
        throw new TypeError(`Collection '${name}' update cannot change id.`);
      }
      delete patch.namespace;
      return coordinator.commitMutation({
        draft: {
          type: `${name}.updated`,
          namespace,
          subject: { type: name, id },
          payload: { id },
          delta: { fields: eventFields(patch) },
          ...identityDraft(mutationOptions.identity),
        },
        mutate: async (context) => {
          const { transaction } = context;
          const current = mapNode<EventCollectionValue<TSelect>>(
            await requireNode(transaction, namespace, id, true),
          );
          let processed: Record<string, unknown> = {
            ...current,
            ...patch,
            id,
          };
          delete processed.namespace;
          delete processed.createdAt;
          delete processed.updatedAt;
          const createdField = definition.timestamps?.createdAt;
          if (createdField && current[createdField] !== undefined) {
            processed[createdField] = current[createdField];
          }
          const updatedField = definition.timestamps?.updatedAt;
          if (updatedField) processed[updatedField] = now().toISOString();
          if (definition.hooks?.beforeUpdate) {
            processed = await definition.hooks.beforeUpdate(
              structuredClone(processed),
              { namespace },
            );
          }
          processed = jsonRecord(processed, `${name} beforeUpdate result`);
          if (processed.id !== id) {
            throw new TypeError(
              `Collection '${name}' beforeUpdate cannot change id.`,
            );
          }
          await canonicalizeCollectionContent(
            context,
            namespace,
            name,
            contentFields,
            processed,
            extractedContent.durable,
            options.assets,
          );
          await validate("update", processed);
          const primaryKey = definition.keys?.[0]?.property ?? "id";
          const sourceId = processed[primaryKey];
          const updated = await transaction.query<NodeRow>(
            `UPDATE ${tables.nodes}
             SET name = $1, content = $2, data = $3::jsonb,
                 source_type = $4, source_id = $5, updated_at = NOW()
             WHERE namespace = $6 AND id = $7 AND type = $8
             RETURNING *`,
            [
              String(processed.name ?? id),
              searchContent(definition, processed),
              JSON.stringify(processed),
              primaryKey === "id" ? null : `${name}:${primaryKey}`,
              primaryKey === "id" || sourceId == null ? null : String(sourceId),
              namespace,
              id,
              name,
            ],
          );
          await synchronizeRelations(transaction, namespace, id, processed);
          if (contentFields.length > 0) {
            await options.assets!.syncOwner(context, {
              namespace,
              ownerId: id,
              content: ownedContent(processed, contentFields),
            });
          }
          return mapNode<EventCollectionValue<TSelect>>(updated.rows[0]);
        },
        recoverDuplicate: async (_event, { transaction }) =>
          mapNode<EventCollectionValue<TSelect>>(
            await requireNode(transaction, namespace, id),
          ),
      });
    },
    command(idInput, commandInput, input, mutationOptions) {
      const namespace = requireText(mutationOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} ID`);
      const command = requireText(commandInput, `${name} command`);
      const commandDefinition = definition.commands?.[command];
      if (!commandDefinition) {
        throw new Error(`Unknown ${name} command '${command}'.`);
      }
      const operationId = mutationOptions.identity?.deduplicationId?.trim() ||
        createId();
      return coordinator.commitMutation({
        draft: {
          type: `${name}.${command}`,
          namespace,
          subject: { type: name, id },
          payload: { id, command, operationId },
          delta: { command },
          ...identityDraft(mutationOptions.identity),
        },
        mutate: async (context) => {
          const { transaction } = context;
          const current = mapNode<EventCollectionValue<TSelect>>(
            await requireNode(transaction, namespace, id, true),
          );
          const commandPatch = await commandDefinition.execute(Object.freeze({
            namespace,
            operationId,
            current: deepFreeze(structuredClone(current)),
            input: structuredClone(input),
          }));
          const extractedContent = extractCollectionContent(
            jsonRecord(commandPatch, `${name}.${command} patch`),
            contentFields,
            name,
          );
          const patch = extractedContent.input;
          if (patch.id !== undefined && patch.id !== id) {
            throw new TypeError(
              `Collection '${name}' command '${command}' cannot change id.`,
            );
          }
          delete patch.namespace;
          let processed: Record<string, unknown> = {
            ...current,
            ...patch,
            id,
          };
          delete processed.namespace;
          delete processed.createdAt;
          delete processed.updatedAt;
          const createdField = definition.timestamps?.createdAt;
          if (createdField && current[createdField] !== undefined) {
            processed[createdField] = current[createdField];
          }
          const updatedField = definition.timestamps?.updatedAt;
          if (updatedField) processed[updatedField] = now().toISOString();
          if (definition.hooks?.beforeUpdate) {
            processed = await definition.hooks.beforeUpdate(
              structuredClone(processed),
              { namespace },
            );
          }
          processed = jsonRecord(
            processed,
            `${name}.${command} beforeUpdate result`,
          );
          if (processed.id !== id) {
            throw new TypeError(
              `Collection '${name}' beforeUpdate cannot change id.`,
            );
          }
          await canonicalizeCollectionContent(
            context,
            namespace,
            name,
            contentFields,
            processed,
            extractedContent.durable,
            options.assets,
          );
          await validate("update", processed);
          const primaryKey = definition.keys?.[0]?.property ?? "id";
          const sourceId = processed[primaryKey];
          const updated = await transaction.query<NodeRow>(
            `UPDATE ${tables.nodes}
             SET name = $1, content = $2, data = $3::jsonb,
                 source_type = $4, source_id = $5, updated_at = NOW()
             WHERE namespace = $6 AND id = $7 AND type = $8
             RETURNING *`,
            [
              String(processed.name ?? id),
              searchContent(definition, processed),
              JSON.stringify(processed),
              primaryKey === "id" ? null : `${name}:${primaryKey}`,
              primaryKey === "id" || sourceId == null ? null : String(sourceId),
              namespace,
              id,
              name,
            ],
          );
          await synchronizeRelations(transaction, namespace, id, processed);
          if (contentFields.length > 0) {
            await options.assets!.syncOwner(context, {
              namespace,
              ownerId: id,
              content: ownedContent(processed, contentFields),
            });
          }
          const result: CollectionCommandResult<TSelect> = Object.freeze({
            command,
            record: mapNode<EventCollectionValue<TSelect>>(updated.rows[0]),
          });
          return result;
        },
        recoverDuplicate: async (_event, { transaction }) =>
          Object.freeze({
            command,
            record: mapNode<EventCollectionValue<TSelect>>(
              await requireNode(transaction, namespace, id),
            ),
          }),
      });
    },
    delete(idInput, mutationOptions) {
      const namespace = requireText(mutationOptions.namespace, "Namespace");
      const id = requireText(idInput, `${name} ID`);
      return coordinator.commitMutation({
        draft: {
          type: `${name}.deleted`,
          namespace,
          subject: { type: name, id },
          payload: { id },
          delta: { deleted: true },
          ...identityDraft(mutationOptions.identity),
        },
        mutate: async ({ transaction }) => {
          await requireNode(transaction, namespace, id, true);
          await definition.hooks?.beforeDelete?.({ id }, { namespace });
          const deleted = await transaction.query<{ id: string }>(
            `DELETE FROM ${tables.nodes}
             WHERE namespace = $1 AND id = $2 AND type = $3
             RETURNING id`,
            [namespace, id, name],
          );
          if (!deleted.rows[0]) {
            throw new Error(`Unknown ${name} '${id}' in '${namespace}'.`);
          }
          return Object.freeze({ id, deleted: true as const });
        },
        recoverDuplicate: () =>
          Promise.resolve(Object.freeze({ id, deleted: true as const })),
      });
    },
    async get(namespaceInput, idInput) {
      const namespace = requireText(namespaceInput, "Namespace");
      const id = requireText(idInput, `${name} ID`);
      const row = await findNode(session, namespace, id);
      return row ? mapNode<EventCollectionValue<TSelect>>(row) : null;
    },
    async list(namespaceInput, listOptions = {}) {
      const namespace = requireText(namespaceInput, "Namespace");
      const params: unknown[] = [namespace, name];
      let cursorFilter = "";
      let whereFilter = "";
      if (listOptions.where) {
        const where = jsonRecord(
          { ...listOptions.where },
          `${name} list filter`,
        );
        if (Object.keys(where).length > 0) {
          params.push(JSON.stringify(where));
          whereFilter = `AND data @> $${params.length}::jsonb`;
        }
      }
      const after = listOptions.after?.trim();
      if (after) {
        const cursor = await findNode(session, namespace, after);
        if (!cursor) {
          throw new Error(
            `Unknown ${name} cursor '${after}' in '${namespace}'.`,
          );
        }
        params.push(iso(cursor.created_at), cursor.id);
        cursorFilter = `AND (created_at, id) > ($${
          params.length - 1
        }::timestamptz, $${params.length})`;
      }
      params.push(boundedLimit(listOptions.limit));
      const result = await session.query<NodeRow>(
        `SELECT * FROM ${tables.nodes}
         WHERE namespace = $1 AND type = $2 ${whereFilter} ${cursorFilter}
         ORDER BY created_at, id LIMIT $${params.length}`,
        params,
      );
      return Object.freeze(
        result.rows.map((row) => mapNode<EventCollectionValue<TSelect>>(row)),
      );
    },
  };

  return Object.freeze(repository);
}
