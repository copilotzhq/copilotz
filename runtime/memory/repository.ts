import type {
  DatabaseAssetRepository,
  PreparedContent,
} from "../content/index.ts";
import type {
  DomainNodeRef,
  MutationIdentity,
  ValidateCollectionRecord,
} from "../domain/index.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../events/index.ts";
import {
  longTermMemoryCollection,
  memoryRecordCollection,
} from "./collections.ts";

type NodeRow = Readonly<{
  id: string;
  namespace: string;
  type: string;
  data: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}>;

export type MemoryRecordWrite =
  | Readonly<{
    operation: "create";
    record: Readonly<Record<string, unknown>> & { id: string };
  }>
  | Readonly<{
    operation: "update";
    id: string;
    patch: Readonly<Record<string, unknown>>;
  }>;

export type MemoryRelationWrite = Readonly<{
  id: string;
  type: string;
  source: DomainNodeRef;
  target: DomainNodeRef;
  metadata?: Readonly<Record<string, unknown>>;
  weight?: number;
}>;

export type CommitMemoryConsolidationInput = Readonly<{
  namespace: string;
  threadId: string;
  checkpointId: string;
  records: readonly MemoryRecordWrite[];
  relations: readonly MemoryRelationWrite[];
  checkpointPatch: Readonly<Record<string, unknown>>;
  checkpointContent: PreparedContent;
  identity?: MutationIdentity;
}>;

export type ScopedCommitMemoryConsolidationInput = Omit<
  CommitMemoryConsolidationInput,
  "namespace" | "identity"
>;

export type MemoryConsolidationCommitResult = Readonly<{
  checkpointId: string;
  createdRecordIds: readonly string[];
  updatedRecordIds: readonly string[];
  relationIds: readonly string[];
}>;

export type MemoryConsolidationRepository = Readonly<{
  commit(
    input: CommitMemoryConsolidationInput,
  ): Promise<CoordinatedMutationResult<MemoryConsolidationCommitResult>>;
}>;

export type ScopedMemoryConsolidation = Readonly<{
  commit(
    input: ScopedCommitMemoryConsolidationInput,
    options?: Readonly<{
      operationKey?: string;
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<MemoryConsolidationCommitResult>;
}>;

export type CreateMemoryConsolidationRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  eventStore: Pick<EventStore, "tables">;
  assets: Pick<DatabaseAssetRepository, "materialize" | "syncOwner">;
  validate?: ValidateCollectionRecord;
}>;

function requiredText(value: unknown, name: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function jsonRecord(value: unknown, name: string): Record<string, unknown> {
  try {
    const encoded = JSON.stringify(value);
    const decoded = encoded === undefined ? undefined : JSON.parse(encoded);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new TypeError(`${name} must be an object.`);
    }
    return decoded;
  } catch (cause) {
    if (cause instanceof TypeError && cause.message.startsWith(name)) {
      throw cause;
    }
    throw new TypeError(`${name} must be JSON serializable.`, { cause });
  }
}

function rowData(row: NodeRow): Record<string, unknown> {
  if (typeof row.data === "string") {
    try {
      return rowData({ ...row, data: JSON.parse(row.data) });
    } catch {
      return {};
    }
  }
  return row.data && typeof row.data === "object" && !Array.isArray(row.data)
    ? structuredClone(row.data as Record<string, unknown>)
    : {};
}

function identityDraft(identity: MutationIdentity | undefined) {
  return {
    ...(identity?.causationId ? { causationId: identity.causationId } : {}),
    ...(identity?.correlationId
      ? { correlationId: identity.correlationId }
      : {}),
    ...(identity?.deduplicationId
      ? { deduplicationId: identity.deduplicationId }
      : {}),
    ...(identity?.settlementScopeId
      ? { settlementScopeId: identity.settlementScopeId }
      : {}),
    metadata: structuredClone(identity?.metadata ?? {}),
  };
}

function edgeId(
  namespace: string,
  type: string,
  sourceId: string,
  targetId: string,
): string {
  return `relation:${JSON.stringify([namespace, type, sourceId, targetId])}`;
}

function uniqueJsonValues(values: readonly unknown[]): readonly unknown[] {
  const seen = new Set<string>();
  return Object.freeze(values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }));
}

async function requireNode(
  transaction: SqlExecutor,
  tables: Pick<EventStore, "tables">["tables"],
  namespace: string,
  type: string,
  id: string,
  lock = false,
): Promise<NodeRow> {
  const result = await transaction.query<NodeRow>(
    `SELECT id, namespace, type, data, created_at, updated_at
     FROM ${tables.nodes}
     WHERE namespace = $1 AND type = $2 AND id = $3
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [namespace, type, id],
  );
  if (!result.rows[0]) {
    throw new Error(`Unknown ${type} '${id}' in '${namespace}'.`);
  }
  return result.rows[0];
}

async function validateRecord(
  validate: ValidateCollectionRecord | undefined,
  definition: typeof memoryRecordCollection | typeof longTermMemoryCollection,
  operation: "create" | "update",
  value: Record<string, unknown>,
): Promise<void> {
  await validate?.({
    definition,
    operation,
    record: Object.freeze(structuredClone(value)),
  });
}

async function insertTypedEdge(
  transaction: SqlExecutor,
  tables: Pick<EventStore, "tables">["tables"],
  input: Readonly<{
    namespace: string;
    id: string;
    type: string;
    source: DomainNodeRef;
    target: DomainNodeRef;
    metadata?: Readonly<Record<string, unknown>>;
    weight?: number;
  }>,
): Promise<void> {
  const type = requiredText(input.type, "Memory relation type");
  const sourceType = requiredText(input.source.type, "Relation source type");
  const sourceId = requiredText(input.source.id, "Relation source ID");
  const targetType = requiredText(input.target.type, "Relation target type");
  const targetId = requiredText(input.target.id, "Relation target ID");
  if (sourceId === targetId) {
    throw new TypeError("A memory relation cannot connect a node to itself.");
  }
  await requireNode(
    transaction,
    tables,
    input.namespace,
    sourceType,
    sourceId,
  );
  await requireNode(
    transaction,
    tables,
    input.namespace,
    targetType,
    targetId,
  );
  const metadata = jsonRecord(input.metadata ?? {}, "Memory relation metadata");
  const weight = input.weight ?? 1;
  if (!Number.isFinite(weight)) {
    throw new TypeError("Memory relation weight must be finite.");
  }
  const inserted = await transaction.query<{ id: string }>(
    `INSERT INTO ${tables.edges} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      requiredText(input.id, "Memory relation ID"),
      input.namespace,
      sourceId,
      targetId,
      type,
      JSON.stringify({ sourceType, targetType, metadata }),
      weight,
    ],
  );
  if (inserted.rows[0]) return;
  const existing = await transaction.query<{
    source_node_id: string;
    target_node_id: string;
    type: string;
    data: unknown;
    weight: string | number;
  }>(
    `SELECT source_node_id, target_node_id, type, data, weight
     FROM ${tables.edges} WHERE namespace = $1 AND id = $2 LIMIT 1`,
    [input.namespace, input.id],
  );
  const row = existing.rows[0];
  const data = jsonRecord(row?.data ?? {}, "Existing relation data");
  if (
    !row || row.source_node_id !== sourceId ||
    row.target_node_id !== targetId ||
    row.type !== type || data.sourceType !== sourceType ||
    data.targetType !== targetType || Number(row.weight) !== weight
  ) {
    throw new Error(`Memory relation ID '${input.id}' conflicts with an edge.`);
  }
  const previous = jsonRecord(
    data.metadata ?? {},
    "Existing relation metadata",
  );
  const checkpoints = uniqueJsonValues([
    ...(Array.isArray(previous.checkpointIds) ? previous.checkpointIds : []),
    previous.checkpointId,
    ...(Array.isArray(metadata.checkpointIds) ? metadata.checkpointIds : []),
    metadata.checkpointId,
  ].filter((value) => value !== undefined));
  const sources = uniqueJsonValues([
    ...(Array.isArray(previous.sources) ? previous.sources : []),
    ...(Array.isArray(metadata.sources) ? metadata.sources : []),
  ]);
  await transaction.query(
    `UPDATE ${tables.edges}
     SET data = $1::jsonb
     WHERE namespace = $2 AND id = $3`,
    [
      JSON.stringify({
        sourceType,
        targetType,
        metadata: {
          ...previous,
          ...metadata,
          ...(checkpoints.length ? { checkpointIds: checkpoints } : {}),
          ...(sources.length ? { sources } : {}),
        },
      }),
      input.namespace,
      input.id,
    ],
  );
}

function resultFromInput(
  input: CommitMemoryConsolidationInput,
): MemoryConsolidationCommitResult {
  return Object.freeze({
    checkpointId: input.checkpointId,
    createdRecordIds: Object.freeze(
      input.records.flatMap((write) =>
        write.operation === "create" ? [write.record.id] : []
      ),
    ),
    updatedRecordIds: Object.freeze(
      input.records.flatMap((write) =>
        write.operation === "update" ? [write.id] : []
      ),
    ),
    relationIds: Object.freeze(input.relations.map((relation) => relation.id)),
  });
}

/** Commits one semantic-memory graph and its ready checkpoint atomically. */
export function createMemoryConsolidationRepository(
  options: CreateMemoryConsolidationRepositoryOptions,
): MemoryConsolidationRepository {
  const tables = options.eventStore.tables;
  return Object.freeze({
    commit(input) {
      const namespace = requiredText(input.namespace, "Namespace");
      const threadId = requiredText(input.threadId, "Memory thread ID");
      const checkpointId = requiredText(
        input.checkpointId,
        "Memory checkpoint ID",
      );
      const result = resultFromInput(input);
      return options.coordinator.commitMutation({
        draft: {
          type: "memory.consolidation.committed",
          namespace,
          threadId,
          subject: { type: longTermMemoryCollection.name, id: checkpointId },
          payload: { checkpointId },
          delta: {
            createdRecordIds: result.createdRecordIds,
            updatedRecordIds: result.updatedRecordIds,
            relationIds: result.relationIds,
          },
          visibility: { kind: "internal" },
          ...identityDraft(input.identity),
        },
        mutate: async (context) => {
          const checkpointRow = await requireNode(
            context.transaction,
            tables,
            namespace,
            longTermMemoryCollection.name,
            checkpointId,
            true,
          );
          const currentCheckpoint = rowData(checkpointRow);
          if (currentCheckpoint.status !== "pending") {
            throw new Error(
              `Memory checkpoint '${checkpointId}' is not pending.`,
            );
          }

          for (const write of input.records) {
            if (write.operation === "create") {
              const value = jsonRecord(
                write.record,
                `Memory record '${write.record.id}'`,
              );
              const id = requiredText(value.id, "Memory record ID");
              if (value.consolidationId !== checkpointId) {
                throw new TypeError(
                  `Memory record '${id}' must belong to checkpoint '${checkpointId}'.`,
                );
              }
              await validateRecord(
                options.validate,
                memoryRecordCollection,
                "create",
                value,
              );
              await context.transaction.query(
                `INSERT INTO ${tables.nodes} (
                   id, namespace, type, name, content, data
                 ) VALUES ($1, $2, $3, $4, $4, $5::jsonb)`,
                [
                  id,
                  namespace,
                  memoryRecordCollection.name,
                  requiredText(value.summary, "Memory summary"),
                  JSON.stringify(value),
                ],
              );
              await insertTypedEdge(context.transaction, tables, {
                namespace,
                id: edgeId(
                  namespace,
                  "has_memory_record",
                  requiredText(value.memorySpaceId, "Memory space ID"),
                  id,
                ),
                type: "has_memory_record",
                source: {
                  type: "memory_space",
                  id: requiredText(value.memorySpaceId, "Memory space ID"),
                },
                target: { type: memoryRecordCollection.name, id },
              });
              await insertTypedEdge(context.transaction, tables, {
                namespace,
                id: edgeId(
                  namespace,
                  "includes_memory_record",
                  checkpointId,
                  id,
                ),
                type: "includes_memory_record",
                source: {
                  type: longTermMemoryCollection.name,
                  id: checkpointId,
                },
                target: { type: memoryRecordCollection.name, id },
              });
              continue;
            }

            const currentRow = await requireNode(
              context.transaction,
              tables,
              namespace,
              memoryRecordCollection.name,
              requiredText(write.id, "Memory record ID"),
              true,
            );
            const value: Record<string, unknown> = {
              ...rowData(currentRow),
              ...jsonRecord(write.patch, `Memory record '${write.id}' patch`),
              id: write.id,
            };
            await validateRecord(
              options.validate,
              memoryRecordCollection,
              "update",
              value,
            );
            await context.transaction.query(
              `UPDATE ${tables.nodes}
               SET name = $1, content = $1, data = $2::jsonb,
                   updated_at = NOW()
               WHERE namespace = $3 AND type = $4 AND id = $5`,
              [
                requiredText(value.summary, "Memory summary"),
                JSON.stringify(value),
                namespace,
                memoryRecordCollection.name,
                write.id,
              ],
            );
          }

          for (const relation of input.relations) {
            await insertTypedEdge(context.transaction, tables, {
              ...relation,
              namespace,
            });
          }

          const preparedContent = await options.assets.materialize(context, {
            namespace,
            content: input.checkpointContent,
          });
          const checkpoint: Record<string, unknown> = {
            ...currentCheckpoint,
            ...jsonRecord(input.checkpointPatch, "Memory checkpoint patch"),
            id: checkpointId,
            content: preparedContent,
          };
          if (checkpoint.status !== "ready") {
            throw new TypeError(
              "Atomic memory consolidation must settle the checkpoint as ready.",
            );
          }
          await validateRecord(
            options.validate,
            longTermMemoryCollection,
            "update",
            checkpoint,
          );
          await context.transaction.query(
            `UPDATE ${tables.nodes}
             SET data = $1::jsonb, updated_at = NOW()
             WHERE namespace = $2 AND type = $3 AND id = $4`,
            [
              JSON.stringify(checkpoint),
              namespace,
              longTermMemoryCollection.name,
              checkpointId,
            ],
          );
          await options.assets.syncOwner(context, {
            namespace,
            ownerId: checkpointId,
            content: preparedContent,
          });
          return result;
        },
        recoverDuplicate: () => Promise.resolve(result),
      });
    },
  });
}
