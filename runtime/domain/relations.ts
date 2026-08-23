import { ulid } from "../../dependencies/ulid.ts";
import type {
  CoordinatedMutationResult,
  EventCoordinator,
  EventStore,
  EventVisibility,
  SqlExecutor,
} from "../events/index.ts";
import type { MutationIdentity } from "./types.ts";

export type DomainNodeRef = Readonly<{ type: string; id: string }>;

export type DomainRelation = Readonly<{
  id: string;
  namespace: string;
  type: string;
  source: DomainNodeRef;
  target: DomainNodeRef;
  metadata: Readonly<Record<string, unknown>>;
  weight: number;
  createdAt: string;
}>;

export type CreateDomainRelationInput = Readonly<{
  namespace: string;
  id?: string;
  type: string;
  source: DomainNodeRef;
  target: DomainNodeRef;
  metadata?: Record<string, unknown>;
  weight?: number;
  threadId?: string;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type DeleteDomainRelationInput = Readonly<{
  namespace: string;
  id: string;
  threadId?: string;
  visibility?: EventVisibility;
  identity?: MutationIdentity;
}>;

export type ListDomainRelationsOptions = Readonly<{
  namespace: string;
  nodeId?: string;
  direction?: "in" | "out" | "both";
  types?: readonly string[];
  limit?: number;
}>;

export type DomainRelationRepository = Readonly<{
  create(
    input: CreateDomainRelationInput,
  ): Promise<CoordinatedMutationResult<DomainRelation>>;
  delete(
    input: DeleteDomainRelationInput,
  ): Promise<CoordinatedMutationResult<{ id: string; deleted: true }>>;
  get(namespace: string, id: string): Promise<DomainRelation | null>;
  list(options: ListDomainRelationsOptions): Promise<readonly DomainRelation[]>;
}>;

export type CreateDomainRelationRepositoryOptions = Readonly<{
  coordinator: EventCoordinator;
  session: SqlExecutor;
  eventStore: Pick<EventStore, "tables">;
  createId?: () => string;
}>;

export type ProjectDomainRelationInput = Readonly<{
  namespace: string;
  id: string;
  type: string;
  source: DomainNodeRef;
  target: DomainNodeRef;
  metadata?: Record<string, unknown>;
  weight?: number;
}>;

type EdgeRow = Readonly<{
  id: string;
  namespace: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  data: unknown;
  weight: number | string | null;
  created_at: string | Date;
}>;

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function relationType(value: string): string {
  const type = requiredText(value, "Relation type");
  if (!/^[a-z][a-z0-9_.-]*$/i.test(type)) {
    throw new TypeError(`Invalid relation type '${type}'.`);
  }
  return type;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function nodeRef(value: DomainNodeRef, name: string): DomainNodeRef {
  return Object.freeze({
    type: requiredText(value.type, `${name} type`),
    id: requiredText(value.id, `${name} ID`),
  });
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

function mapEdge(row: EdgeRow): DomainRelation {
  const data = jsonRecord(row.data);
  const sourceType = typeof data.sourceType === "string"
    ? data.sourceType
    : "node";
  const targetType = typeof data.targetType === "string"
    ? data.targetType
    : "node";
  return Object.freeze({
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    source: Object.freeze({ type: sourceType, id: row.source_node_id }),
    target: Object.freeze({ type: targetType, id: row.target_node_id }),
    metadata: Object.freeze(jsonRecord(data.metadata)),
    weight: Number(row.weight ?? 1),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
  });
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Relation limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
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

/**
 * Projects a graph relation inside an already-open aggregate transaction.
 *
 * This does not emit a separate `relation.created` event. It is for Collection
 * or Action transactions whose parent event owns the semantic mutation.
 */
export async function projectDomainRelation(
  transaction: SqlExecutor,
  tables: Pick<EventStore, "tables">["tables"],
  input: ProjectDomainRelationInput,
): Promise<DomainRelation> {
  const namespace = requiredText(input.namespace, "Namespace");
  const id = requiredText(input.id, "Relation ID");
  const type = relationType(input.type);
  const source = nodeRef(input.source, "Relation source");
  const target = nodeRef(input.target, "Relation target");
  if (source.id === target.id) {
    throw new TypeError("A relation cannot connect a node to itself.");
  }
  const metadata = jsonRecord(input.metadata);
  const weight = input.weight ?? 1;
  if (!Number.isFinite(weight)) {
    throw new TypeError("Relation weight must be finite.");
  }
  for (
    const [label, ref] of [["source", source], ["target", target]] as const
  ) {
    const result = await transaction.query<{ id: string }>(
      `SELECT id FROM ${tables.nodes}
       WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
      [namespace, ref.id, ref.type],
    );
    if (!result.rows[0]) {
      throw new Error(
        `Relation ${label} ${ref.type} '${ref.id}' was not found.`,
      );
    }
  }
  const inserted = await transaction.query<EdgeRow>(
    `INSERT INTO ${tables.edges} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      id,
      namespace,
      source.id,
      target.id,
      type,
      JSON.stringify({
        sourceType: source.type,
        targetType: target.type,
        metadata,
      }),
      weight,
    ],
  );
  if (inserted.rows[0]) return mapEdge(inserted.rows[0]);

  const existing = await transaction.query<EdgeRow>(
    `SELECT * FROM ${tables.edges}
     WHERE namespace = $1 AND id = $2 LIMIT 1`,
    [namespace, id],
  );
  const row = existing.rows[0];
  const data = jsonRecord(row?.data);
  if (
    !row || row.source_node_id !== source.id ||
    row.target_node_id !== target.id ||
    row.type !== type ||
    data.sourceType !== source.type ||
    data.targetType !== target.type ||
    Number(row.weight ?? 1) !== weight
  ) {
    throw new Error(`Relation ID '${id}' conflicts with an edge.`);
  }

  const previous = jsonRecord(data.metadata);
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
  const merged = {
    ...previous,
    ...metadata,
    ...(checkpoints.length ? { checkpointIds: checkpoints } : {}),
    ...(sources.length ? { sources } : {}),
  };
  const updated = await transaction.query<EdgeRow>(
    `UPDATE ${tables.edges}
     SET data = $1::jsonb
     WHERE namespace = $2 AND id = $3
     RETURNING *`,
    [
      JSON.stringify({
        sourceType: source.type,
        targetType: target.type,
        metadata: merged,
      }),
      namespace,
      id,
    ],
  );
  return mapEdge(updated.rows[0]);
}

/** Creates direct graph relationships through a typed event-native boundary. */
export function createDomainRelationRepository(
  options: CreateDomainRelationRepositoryOptions,
): DomainRelationRepository {
  const tables = options.eventStore.tables;
  const createId = options.createId ?? ulid;
  const find = async (
    executor: SqlExecutor,
    namespace: string,
    id: string,
  ): Promise<EdgeRow | null> => {
    const result = await executor.query<EdgeRow>(
      `SELECT * FROM ${tables.edges}
       WHERE namespace = $1 AND id = $2 LIMIT 1`,
      [namespace, id],
    );
    return result.rows[0] ?? null;
  };

  const repository: DomainRelationRepository = Object.freeze({
    create(input) {
      const namespace = requiredText(input.namespace, "Namespace");
      const type = relationType(input.type);
      const source = nodeRef(input.source, "Relation source");
      const target = nodeRef(input.target, "Relation target");
      if (source.id === target.id) {
        throw new TypeError("A relation cannot connect a node to itself.");
      }
      const metadata = jsonRecord(input.metadata);
      const weight = input.weight ?? 1;
      if (!Number.isFinite(weight)) {
        throw new TypeError("Relation weight must be finite.");
      }
      const id = input.id?.trim() ||
        (input.identity?.deduplicationId
          ? `${namespace}:relation:${input.identity.deduplicationId}`
          : createId());
      return options.coordinator.commitMutation({
        draft: {
          type: "relation.created",
          namespace,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          subject: { type: "relation", id },
          payload: { relationId: id },
          delta: {
            type,
            source: { type: source.type, id: source.id },
            target: { type: target.type, id: target.id },
          },
          visibility: input.visibility ?? { kind: "internal" },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction }) => {
          for (
            const [label, ref] of [["source", source], [
              "target",
              target,
            ]] as const
          ) {
            const result = await transaction.query<{ id: string }>(
              `SELECT id FROM ${tables.nodes}
               WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
              [namespace, ref.id, ref.type],
            );
            if (!result.rows[0]) {
              throw new Error(
                `Relation ${label} ${ref.type} '${ref.id}' was not found.`,
              );
            }
          }
          const inserted = await transaction.query<EdgeRow>(
            `INSERT INTO ${tables.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
             RETURNING *`,
            [
              id,
              namespace,
              source.id,
              target.id,
              type,
              JSON.stringify({
                sourceType: source.type,
                targetType: target.type,
                metadata,
              }),
              weight,
            ],
          );
          return mapEdge(inserted.rows[0]);
        },
        recoverDuplicate: async (_event, { transaction }) => {
          const row = await find(transaction, namespace, id);
          if (!row) throw new Error(`Relation '${id}' could not be recovered.`);
          return mapEdge(row);
        },
      });
    },

    async delete(input) {
      const namespace = requiredText(input.namespace, "Namespace");
      const id = requiredText(input.id, "Relation ID");
      const current = await find(options.session, namespace, id);
      if (!current) throw new Error(`Relation '${id}' was not found.`);
      return await options.coordinator.commitMutation({
        draft: {
          type: "relation.deleted",
          namespace,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          subject: { type: "relation", id },
          payload: { relationId: id },
          delta: { deleted: true },
          visibility: input.visibility ?? { kind: "internal" },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction }) => {
          const deleted = await transaction.query<{ id: string }>(
            `DELETE FROM ${tables.edges}
             WHERE namespace = $1 AND id = $2 RETURNING id`,
            [namespace, id],
          );
          if (!deleted.rows[0]) throw new Error(`Relation '${id}' vanished.`);
          return Object.freeze({ id, deleted: true as const });
        },
        recoverDuplicate: () =>
          Promise.resolve(Object.freeze({ id, deleted: true as const })),
      });
    },

    async get(namespaceInput, idInput) {
      const row = await find(
        options.session,
        requiredText(namespaceInput, "Namespace"),
        requiredText(idInput, "Relation ID"),
      );
      return row ? mapEdge(row) : null;
    },

    async list(input) {
      const namespace = requiredText(input.namespace, "Namespace");
      const params: unknown[] = [namespace];
      const filters: string[] = ["namespace = $1"];
      if (input.nodeId) {
        const id = requiredText(input.nodeId, "Relation node ID");
        params.push(id);
        const parameter = `$${params.length}`;
        const direction = input.direction ?? "both";
        filters.push(
          direction === "out"
            ? `source_node_id = ${parameter}`
            : direction === "in"
            ? `target_node_id = ${parameter}`
            : `(source_node_id = ${parameter} OR target_node_id = ${parameter})`,
        );
      }
      if (input.types?.length) {
        params.push([...new Set(input.types.map(relationType))]);
        filters.push(`type = ANY($${params.length}::text[])`);
      }
      params.push(boundedLimit(input.limit));
      const result = await options.session.query<EdgeRow>(
        `SELECT * FROM ${tables.edges}
         WHERE ${filters.join(" AND ")}
         ORDER BY created_at, id LIMIT $${params.length}`,
        params,
      );
      return Object.freeze(result.rows.map(mapEdge));
    },
  });
  return repository;
}
