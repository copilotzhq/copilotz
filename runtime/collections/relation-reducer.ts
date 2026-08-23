import type { EventMutationContext, SqlExecutor } from "../events/index.ts";
import { sameValue } from "./equal.ts";
import type {
  CollectionGraphRelation,
  GraphRelationUpsertInput,
} from "./types.ts";

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

function mapEdge(row: EdgeRow): CollectionGraphRelation {
  const data = jsonRecord(row.data);
  return Object.freeze({
    id: row.id,
    namespace: row.namespace,
    type: row.type,
    source: Object.freeze({
      type: typeof data.sourceType === "string" ? data.sourceType : "node",
      id: row.source_node_id,
    }),
    target: Object.freeze({
      type: typeof data.targetType === "string" ? data.targetType : "node",
      id: row.target_node_id,
    }),
    metadata: Object.freeze(jsonRecord(data.metadata)),
    weight: Number(row.weight ?? 1),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
  });
}

export async function loadGraphRelation(
  executor: SqlExecutor,
  tables: Readonly<{ edges: string }>,
  namespace: string,
  id: string,
  lock = false,
): Promise<CollectionGraphRelation | null> {
  const result = await executor.query<EdgeRow>(
    `SELECT * FROM ${tables.edges}
     WHERE namespace = $1 AND id = $2
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [namespace, id],
  );
  return result.rows[0] ? mapEdge(result.rows[0]) : null;
}

export function normalizeGraphRelation(
  namespaceInput: string,
  input: GraphRelationUpsertInput & Readonly<{ id: string }>,
  createdAt: string,
): CollectionGraphRelation {
  const namespace = requiredText(namespaceInput, "Namespace");
  const id = requiredText(input.id, "Relation ID");
  const source = Object.freeze({
    type: requiredText(input.source.type, "Relation source type"),
    id: requiredText(input.source.id, "Relation source ID"),
  });
  const target = Object.freeze({
    type: requiredText(input.target.type, "Relation target type"),
    id: requiredText(input.target.id, "Relation target ID"),
  });
  if (source.id === target.id) {
    throw new TypeError("A relation cannot connect a node to itself.");
  }
  const weight = input.weight ?? 1;
  if (!Number.isFinite(weight)) {
    throw new TypeError("Relation weight must be finite.");
  }
  return Object.freeze({
    id,
    namespace,
    type: relationType(input.type),
    source,
    target,
    metadata: Object.freeze(jsonRecord(input.metadata)),
    weight,
    createdAt: new Date(createdAt).toISOString(),
  });
}

/** Folds one relation intent over its immutable expected projection. */
export function mergeGraphRelation(
  existing: CollectionGraphRelation | null,
  intent: CollectionGraphRelation,
): CollectionGraphRelation {
  if (!existing) return intent;
  if (
    existing.source.id !== intent.source.id ||
    existing.target.id !== intent.target.id ||
    existing.type !== intent.type ||
    existing.source.type !== intent.source.type ||
    existing.target.type !== intent.target.type ||
    existing.weight !== intent.weight
  ) {
    throw new Error(`Relation ID '${intent.id}' conflicts with an edge.`);
  }
  return Object.freeze({
    ...intent,
    createdAt: existing.createdAt,
  });
}

/** Applies one durable relation body to the graph projection. */
export async function projectGraphRelation(
  context: EventMutationContext,
  relation: CollectionGraphRelation,
): Promise<CollectionGraphRelation> {
  for (
    const [label, ref] of [
      ["source", relation.source],
      ["target", relation.target],
    ] as const
  ) {
    const result = await context.transaction.query<{ id: string }>(
      `SELECT id FROM ${context.tables.nodes}
       WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
      [relation.namespace, ref.id, ref.type],
    );
    if (!result.rows[0]) {
      throw new Error(
        `Relation ${label} ${ref.type} '${ref.id}' was not found.`,
      );
    }
  }

  const inserted = await context.transaction.query<EdgeRow>(
    `INSERT INTO ${context.tables.edges} (
       id, namespace, source_node_id, target_node_id, type, data, weight,
       created_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (id) DO NOTHING
     RETURNING *`,
    [
      relation.id,
      relation.namespace,
      relation.source.id,
      relation.target.id,
      relation.type,
      JSON.stringify({
        sourceType: relation.source.type,
        targetType: relation.target.type,
        metadata: relation.metadata,
      }),
      relation.weight,
      relation.createdAt,
    ],
  );
  if (inserted.rows[0]) return mapEdge(inserted.rows[0]);

  const existing = await loadGraphRelation(
    context.transaction,
    context.tables,
    relation.namespace,
    relation.id,
    true,
  );
  if (
    !existing || existing.source.id !== relation.source.id ||
    existing.target.id !== relation.target.id ||
    existing.type !== relation.type ||
    existing.source.type !== relation.source.type ||
    existing.target.type !== relation.target.type ||
    existing.weight !== relation.weight
  ) {
    throw new Error(`Relation ID '${relation.id}' conflicts with an edge.`);
  }
  if (sameValue(existing, relation)) return existing;
  const updated = await context.transaction.query<EdgeRow>(
    `UPDATE ${context.tables.edges}
     SET data = $1::jsonb, weight = $2
     WHERE namespace = $3 AND id = $4
     RETURNING *`,
    [
      JSON.stringify({
        sourceType: relation.source.type,
        targetType: relation.target.type,
        metadata: relation.metadata,
      }),
      relation.weight,
      relation.namespace,
      relation.id,
    ],
  );
  return mapEdge(updated.rows[0]);
}
