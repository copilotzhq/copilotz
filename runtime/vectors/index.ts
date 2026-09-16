/** Optional pgvector storage for collection-owned vector projections. @module */
import {
  createCoreTableNames,
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  type CollectionPredicate,
  compileCollectionPredicate,
} from "../collections/predicate.ts";
import { mapNode, type NodeRow } from "../collections/reducer.ts";
import type { CollectionRecord } from "../collections/types.ts";

export type VectorProfile = Readonly<
  {
    model: string;
    revision: string;
    dimensions: number;
    metric: "cosine" | "l2" | "innerProduct";
  }
>;
export type VectorWrite = Readonly<{
  ownerType: string;
  ownerId: string;
  field: string;
  profile: VectorProfile;
  /** Scalar record field whose text produced this vector. */
  sourceField: string;
  source: string;
  values: readonly number[];
  assetId?: string;
}>;
export type VectorSearch = Readonly<{
  ownerType: string;
  field: string;
  profile: VectorProfile;
  values: readonly number[];
  /** Applied to owner records in SQL before distance ordering and LIMIT. */
  filter: CollectionPredicate;
  limit?: number;
}>;
export type VectorMatch = Readonly<
  { record: CollectionRecord; distance: number }
>;
export type VectorTransaction = Readonly<
  { upsert(input: VectorWrite): Promise<void> }
>;
export type VectorReader = Readonly<
  { search(input: VectorSearch): Promise<readonly VectorMatch[]> }
>;

export function vectorTable(schema: string): string {
  return `${
    quoteEventIdentifier(validateEventSchemaName(schema))
  }."copilotz_vectors"`;
}
export function vectorProfileKey(profile: VectorProfile): string {
  if (
    !profile.model?.trim() || !profile.revision?.trim() ||
    !Number.isInteger(profile.dimensions) || profile.dimensions < 1 ||
    profile.dimensions > 16000 ||
    !["cosine", "l2", "innerProduct"].includes(profile.metric)
  ) throw new TypeError("Invalid vector profile.");
  return JSON.stringify([
    profile.model,
    profile.revision,
    profile.dimensions,
    profile.metric,
  ]);
}
export function validateVector(
  profile: VectorProfile,
  values: readonly number[],
): string {
  vectorProfileKey(profile);
  if (
    !Array.isArray(values) || values.length !== profile.dimensions ||
    values.some((v) => typeof v !== "number" || !Number.isFinite(v)) ||
    profile.metric === "cosine" && values.every((v) => v === 0)
  ) {
    throw new TypeError(
      "Vector must contain finite values matching its profile dimensions and a nonzero cosine norm.",
    );
  }
  return JSON.stringify(values);
}
function field(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError("Invalid vector field.");
  }
  return value;
}
/** Explicit host setup. Base runtime provisioning never requires the extension. */
export async function provisionVectorStorage(
  session: SqlSession,
  schema = "public",
): Promise<void> {
  const table = vectorTable(schema);
  const nodes = createCoreTableNames(schema).nodes;
  await session.transaction(async (tx) => {
    await tx.query("CREATE EXTENSION IF NOT EXISTS vector");
    await tx.query(`CREATE TABLE IF NOT EXISTS ${table} (
      namespace TEXT NOT NULL, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES ${nodes}(id) ON DELETE CASCADE,
      field TEXT NOT NULL, profile TEXT NOT NULL, dimensions INTEGER NOT NULL,
      source_field TEXT NOT NULL, source_revision TEXT NOT NULL,
      value vector NOT NULL, asset_id TEXT REFERENCES ${nodes}(id) ON DELETE CASCADE,
      PRIMARY KEY(namespace, owner_type, owner_id, field, profile),
      CHECK(vector_dims(value) = dimensions)
    )`);
  });
}
export async function projectVector(
  executor: SqlExecutor,
  schema: string,
  namespace: string,
  input: VectorWrite,
): Promise<void> {
  const values = validateVector(input.profile, input.values);
  field(input.field);
  field(input.sourceField);
  const table = vectorTable(schema);
  const nodes = createCoreTableNames(schema).nodes;
  const result = await executor.query<{ id: string }>(
    `SELECT id FROM ${nodes} WHERE id = $1 AND namespace = $2 AND type = $3 AND data ->> $4 = $5`,
    [
      input.ownerId,
      namespace,
      input.ownerType,
      input.sourceField,
      input.source,
    ],
  );
  if (!result.rows.length) {
    throw new Error(
      "Vector owner or source revision does not match the current record.",
    );
  }
  if (input.assetId) {
    const asset = await executor.query(
      `SELECT id FROM ${nodes} WHERE id = $1 AND namespace = $2 AND type = 'asset'`,
      [input.assetId, namespace],
    );
    if (!asset.rows.length) {
      throw new Error("Vector asset must belong to the same namespace.");
    }
  }
  await executor.query(
    `INSERT INTO ${table} (namespace, owner_type, owner_id, field, profile, dimensions, source_field, source_revision, value, asset_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,md5($8),$9::vector,$10)
    ON CONFLICT (namespace, owner_type, owner_id, field, profile) DO UPDATE SET
    dimensions=EXCLUDED.dimensions, source_field=EXCLUDED.source_field, source_revision=EXCLUDED.source_revision, value=EXCLUDED.value, asset_id=EXCLUDED.asset_id`,
    [
      namespace,
      input.ownerType,
      input.ownerId,
      input.field,
      vectorProfileKey(input.profile),
      input.profile.dimensions,
      input.sourceField,
      input.source,
      values,
      input.assetId ?? null,
    ],
  );
}
export async function searchVectors(
  executor: SqlExecutor,
  schema: string,
  namespace: string,
  input: VectorSearch,
): Promise<readonly VectorMatch[]> {
  const value = validateVector(input.profile, input.values);
  field(input.field);
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError("Vector limit must be between 1 and 1000.");
  }
  const operator =
    { cosine: "<=>", l2: "<->", innerProduct: "<#>" }[input.profile.metric];
  const params: unknown[] = [
    namespace,
    input.ownerType,
    input.field,
    vectorProfileKey(input.profile),
    value,
  ];
  const predicate = compileCollectionPredicate(input.filter, params);
  const limitParameter = params.push(limit);
  // The subquery applies the same bounded predicates as Collection reads. No candidate cap precedes authorization.
  const result = await executor.query<NodeRow & { distance: number }>(
    `SELECT owner.*, (vectors.value ${operator} $5::vector) AS distance
    FROM (SELECT * FROM ${
      createCoreTableNames(schema).nodes
    } WHERE namespace=$1 AND type=$2 AND (${predicate})) AS owner
    JOIN ${
      vectorTable(schema)
    } AS vectors ON vectors.owner_id=owner.id AND vectors.namespace=owner.namespace AND vectors.owner_type=owner.type
    WHERE vectors.field=$3 AND vectors.profile=$4 AND vectors.source_revision=md5(owner.data ->> vectors.source_field)
    ORDER BY distance, owner.id LIMIT $${limitParameter}`,
    params,
  );
  return result.rows.map((row) => ({
    record: mapNode(row),
    distance: Number(row.distance),
  }));
}
