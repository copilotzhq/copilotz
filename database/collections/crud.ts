/**
 * CRUD operations implementation for collections.
 * 
 * Maps collection operations to the underlying graph structure (nodes + edges).
 * 
 * @module
 */

import { ulid } from "ulid";
import type { DbInstance } from "../index.ts";
import type {
  CollectionDefinition,
  CollectionCrud,
  WhereFilter,
  QueryOptions,
  SearchOptions,
  RelationDefinition,
  HookContext,
} from "./types.ts";

// ============================================
// HELPER TYPES
// ============================================

interface NodeRow {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: Record<string, unknown>;
  embedding: number[] | null;
  source_type: string | null;
  source_id: string | null;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

interface EdgeRow {
  id: string;
  source_node_id: string;
  target_node_id: string;
  type: string;
  data: Record<string, unknown> | null;
  weight: number | null;
  created_at: Date;
  [key: string]: unknown;
}

// ============================================
// QUERY BUILDER
// ============================================

interface QueryBuilderResult {
  clause: string;
  params: unknown[];
  paramIndex: number;
}

/**
 * Build data-only filter conditions (no namespace/type).
 * Used for logical operators like $and, $or, $not.
 */
function buildDataFilter<T>(
  filter: Record<string, unknown>,
  startParamIndex: number,
): { conditions: string[]; params: unknown[]; paramIndex: number } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = startParamIndex;

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    // Handle logical operators
    if (key === "$and" && Array.isArray(value)) {
      const subConditions: string[] = [];
      for (const subFilter of value) {
        const sub = buildDataFilter<T>(subFilter as Record<string, unknown>, paramIdx);
        if (sub.conditions.length > 0) {
          subConditions.push(`(${sub.conditions.join(" AND ")})`);
        }
        params.push(...sub.params);
        paramIdx = sub.paramIndex;
      }
      if (subConditions.length > 0) {
        conditions.push(`(${subConditions.join(" AND ")})`);
      }
      continue;
    }

    if (key === "$or" && Array.isArray(value)) {
      const subConditions: string[] = [];
      for (const subFilter of value) {
        const sub = buildDataFilter<T>(subFilter as Record<string, unknown>, paramIdx);
        if (sub.conditions.length > 0) {
          subConditions.push(`(${sub.conditions.join(" AND ")})`);
        }
        params.push(...sub.params);
        paramIdx = sub.paramIndex;
      }
      if (subConditions.length > 0) {
        conditions.push(`(${subConditions.join(" OR ")})`);
      }
      continue;
    }

    if (key === "$not" && typeof value === "object" && value !== null) {
      const sub = buildDataFilter<T>(value as Record<string, unknown>, paramIdx);
      if (sub.conditions.length > 0) {
        conditions.push(`NOT (${sub.conditions.join(" AND ")})`);
      }
      params.push(...sub.params);
      paramIdx = sub.paramIndex;
      continue;
    }

    // Handle field conditions
    const jsonPath = key.includes(".")
      ? `"data"${key.split(".").map((p) => `->'${p}'`).join("")}`
      : `"data"->>'${key}'`;
    const jsonPathValue = key.includes(".")
      ? `"data"${key.split(".").slice(0, -1).map((p) => `->'${p}'`).join("")}->>'${key.split(".").pop()}'`
      : `"data"->>'${key}'`;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Handle operators
      const operators = value as Record<string, unknown>;
      for (const [op, opValue] of Object.entries(operators)) {
        if (opValue === undefined) continue;

        switch (op) {
          case "$eq":
            conditions.push(`${jsonPath} = $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$ne":
            conditions.push(`${jsonPath} != $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$in":
            conditions.push(`${jsonPath} = ANY($${paramIdx})`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$nin":
            conditions.push(`NOT (${jsonPath} = ANY($${paramIdx}))`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$gt":
            conditions.push(`(${jsonPath})::numeric > $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$gte":
            conditions.push(`(${jsonPath})::numeric >= $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$lt":
            conditions.push(`(${jsonPath})::numeric < $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$lte":
            conditions.push(`(${jsonPath})::numeric <= $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$like":
            conditions.push(`${jsonPath} LIKE $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$ilike":
            conditions.push(`${jsonPath} ILIKE $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$regex":
            conditions.push(`${jsonPath} ~ $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$startsWith":
            conditions.push(`${jsonPath} LIKE $${paramIdx}`);
            params.push(`${opValue}%`);
            paramIdx++;
            break;
          case "$endsWith":
            conditions.push(`${jsonPath} LIKE $${paramIdx}`);
            params.push(`%${opValue}`);
            paramIdx++;
            break;
          case "$contains":
            conditions.push(`"data"->'${key}' @> $${paramIdx}::jsonb`);
            params.push(JSON.stringify([opValue]));
            paramIdx++;
            break;
          case "$hasKey":
            conditions.push(`"data"->'${key}' ? $${paramIdx}`);
            params.push(opValue);
            paramIdx++;
            break;
          case "$isEmpty":
            if (opValue) {
              conditions.push(`(${jsonPathValue} IS NULL OR ${jsonPathValue} = '')`);
            } else {
              conditions.push(`${jsonPathValue} IS NOT NULL AND ${jsonPathValue} != ''`);
            }
            break;
          case "$exists":
            if (opValue) {
              conditions.push(`"data" ? '${key}'`);
            } else {
              conditions.push(`NOT ("data" ? '${key}')`);
            }
            break;
        }
      }
    } else {
      // Simple equality
      if (value === null) {
        conditions.push(`("data"->'${key}' IS NULL OR "data"->'${key}' = 'null'::jsonb)`);
      } else if (Array.isArray(value)) {
        conditions.push(`"data"->'${key}' = $${paramIdx}::jsonb`);
        params.push(JSON.stringify(value));
        paramIdx++;
      } else {
        conditions.push(`${jsonPathValue} = $${paramIdx}`);
        params.push(String(value));
        paramIdx++;
      }
    }
  }

  return { conditions, params, paramIndex: paramIdx };
}

function buildWhereClause<T>(
  filter: WhereFilter<T>,
  namespace: string,
  typeName: string,
  startParamIndex = 1,
): QueryBuilderResult {
  const conditions: string[] = [
    `"namespace" = $${startParamIndex}`,
    `"type" = $${startParamIndex + 1}`,
  ];
  const params: unknown[] = [namespace, typeName];
  const paramIdx = startParamIndex + 2;

  // Build data filter conditions
  const dataResult = buildDataFilter<T>(filter as Record<string, unknown>, paramIdx);
  conditions.push(...dataResult.conditions);
  params.push(...dataResult.params);

  return {
    clause: conditions.join(" AND "),
    params,
    paramIndex: dataResult.paramIndex,
  };
}

function buildOrderClause<T>(sort?: Array<[keyof T | string, "asc" | "desc"]>): string {
  if (!sort?.length) {
    return 'ORDER BY "created_at" DESC';
  }

  const sortParts = sort.map(([field, dir]) => {
    const direction = dir.toUpperCase();
    if (field === "createdAt" || field === "created_at") {
      return `"created_at" ${direction}`;
    }
    if (field === "updatedAt" || field === "updated_at") {
      return `"updated_at" ${direction}`;
    }
    if (field === "id") {
      return `"id" ${direction}`;
    }
    return `"data"->>'${String(field)}' ${direction}`;
  });

  return `ORDER BY ${sortParts.join(", ")}`;
}

// ============================================
// NODE MAPPER
// ============================================

function mapNodeToRecord<T>(node: NodeRow): T {
  const data = node.data ?? {};
  return {
    id: node.id,
    ...data,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
  } as T;
}

// ============================================
// CRUD FACTORY
// ============================================

/**
 * Creates a CRUD interface for a collection.
 */
export function createCollectionCrud<TSelect, TInsert>(
  db: DbInstance,
  definition: CollectionDefinition,
  embeddingFn?: (text: string) => Promise<number[]>,
): CollectionCrud<TSelect, TInsert> {
  const { name, timestamps, defaults, relations, search, hooks } = definition;

  // ----------------------------------------
  // Helpers
  // ----------------------------------------

  const applyDefaults = (data: Record<string, unknown>): Record<string, unknown> => {
    const result = { ...data };
    if (defaults) {
      for (const [key, value] of Object.entries(defaults)) {
        if (result[key] === undefined) {
          result[key] = typeof value === "function" ? value() : value;
        }
      }
    }
    if (!result.id) {
      result.id = ulid();
    }
    return result;
  };

  const applyTimestamps = (
    data: Record<string, unknown>,
    isUpdate = false,
  ): Record<string, unknown> => {
    const now = new Date().toISOString();
    const result = { ...data };
    if (timestamps?.updatedAt) {
      result[timestamps.updatedAt] = now;
    }
    if (!isUpdate && timestamps?.createdAt) {
      result[timestamps.createdAt] = now;
    }
    return result;
  };

  const generateEmbedding = async (
    data: Record<string, unknown>,
  ): Promise<number[] | null> => {
    if (!search?.enabled || !embeddingFn || !search.fields.length) return null;
    const text = search.fields
      .map((f) => {
        const value = data[f];
        if (typeof value === "string") return value;
        if (typeof value === "object" && value !== null) return JSON.stringify(value);
        return String(value ?? "");
      })
      .filter(Boolean)
      .join(" ");
    if (!text.trim()) return null;
    return await embeddingFn(text);
  };

  const getSearchContent = (data: Record<string, unknown>): string | null => {
    if (!search?.enabled || !search.fields.length) return null;
    return search.fields
      .map((f) => {
        const value = data[f];
        if (typeof value === "string") return value;
        return "";
      })
      .filter(Boolean)
      .join(" ") || null;
  };

  const getEdgeType = (_relationName: string, relation: RelationDefinition): string => {
    if (relation.edgeType) return relation.edgeType;
    return `HAS_${relation.collection.toUpperCase()}`;
  };

  // ----------------------------------------
  // Populate Relations
  // ----------------------------------------

  const populateRelations = async (
    records: TSelect[],
    populatePaths: string[],
    namespace: string,
  ): Promise<TSelect[]> => {
    if (!populatePaths.length || !relations) return await Promise.resolve(records);

    for (const record of records) {
      for (const path of populatePaths) {
        const parts = path.split(".");
        const relationName = parts[0];
        const nestedPath = parts.slice(1).join(".");

        const relation = relations[relationName];
        if (!relation) continue;

        const recordAny = record as Record<string, unknown>;
        const recordId = recordAny.id as string;

        if (relation.type === "belongsTo") {
          const foreignKeyValue = recordAny[relation.foreignKey];
          if (!foreignKeyValue) {
            recordAny[relationName] = null;
            continue;
          }

          const result = await db.query<NodeRow>(
            `SELECT * FROM "nodes" WHERE "id" = $1 AND "namespace" = $2 AND "type" = $3`,
            [foreignKeyValue, namespace, relation.collection],
          );

          if (result.rows[0]) {
            let related = mapNodeToRecord<TSelect>(result.rows[0]);
            if (nestedPath && relations) {
              const arr = await populateRelations([related], [nestedPath], namespace);
              related = arr[0];
            }
            recordAny[relationName] = related;
          } else {
            recordAny[relationName] = null;
          }
        } else if (relation.type === "hasOne" || relation.type === "hasMany") {
          const edgeType = getEdgeType(relationName, relation);

          const edgeResult = await db.query<EdgeRow>(
            `SELECT "target_node_id" FROM "edges" 
             WHERE "source_node_id" = $1 AND "type" = $2`,
            [recordId, edgeType],
          );

          const targetIds = edgeResult.rows.map((r) => r.target_node_id);

          if (targetIds.length > 0) {
            const nodeResult = await db.query<NodeRow>(
              `SELECT * FROM "nodes" 
               WHERE "id" = ANY($1) AND "namespace" = $2 AND "type" = $3`,
              [targetIds, namespace, relation.collection],
            );

            let relatedRecords = nodeResult.rows.map(mapNodeToRecord<TSelect>);

            if (nestedPath && relations) {
              relatedRecords = await populateRelations(relatedRecords, [nestedPath], namespace);
            }

            if (relation.type === "hasOne") {
              recordAny[relationName] = relatedRecords[0] ?? null;
            } else {
              recordAny[relationName] = relatedRecords;
            }
          } else {
            recordAny[relationName] = relation.type === "hasMany" ? [] : null;
          }
        }
      }
    }

    return records;
  };

  // Note: Edge creation is handled inline in create() for belongsTo relations

  // ----------------------------------------
  // Hook Context
  // ----------------------------------------

  const createHookContext = (namespace: string): HookContext => ({
    namespace,
  });

  // ----------------------------------------
  // CRUD Operations
  // ----------------------------------------

  const crud: CollectionCrud<TSelect, TInsert> = {
    // ========================================
    // CREATE
    // ========================================
    async create(data: TInsert, options: { namespace: string }): Promise<TSelect> {
      let processedData = applyTimestamps(applyDefaults(data as Record<string, unknown>));

      // Run beforeCreate hook
      if (hooks?.beforeCreate) {
        processedData = await hooks.beforeCreate(processedData, createHookContext(options.namespace));
      }

      const embedding = await generateEmbedding(processedData);
      const searchContent = getSearchContent(processedData);

      const result = await db.query<NodeRow>(
        `INSERT INTO "nodes" (
          "id", "namespace", "type", "name", "content", "data", "embedding", "created_at", "updated_at"
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::vector, NOW(), NOW()
        ) RETURNING *`,
        [
          processedData.id,
          options.namespace,
          name,
          String(processedData.name ?? processedData.id),
          searchContent,
          processedData,
          embedding ? `[${embedding.join(",")}]` : null,
        ],
      );

      const record = mapNodeToRecord<TSelect>(result.rows[0]);

      // Create edges for relations if foreign keys are present
      if (relations) {
        for (const [_relationName, relation] of Object.entries(relations)) {
          if (relation.type === "belongsTo") {
            const foreignKeyValue = processedData[relation.foreignKey] as string | undefined;
            if (foreignKeyValue) {
              // Create reverse edge from parent to this record
              const reverseEdgeType = `HAS_${name.toUpperCase()}`;
              await db.query(
                `INSERT INTO "edges" ("id", "source_node_id", "target_node_id", "type", "data", "weight", "created_at")
                 VALUES ($1, $2, $3, $4, '{}', 1.0, NOW())
                 ON CONFLICT DO NOTHING`,
                [ulid(), foreignKeyValue, processedData.id, reverseEdgeType],
              );
            }
          }
        }
      }

      // Run afterCreate hook
      if (hooks?.afterCreate) {
        await hooks.afterCreate(record, createHookContext(options.namespace));
      }

      return record;
    },

    // ========================================
    // CREATE MANY
    // ========================================
    async createMany(
      dataArray: TInsert[],
      options: { namespace: string },
    ): Promise<TSelect[]> {
      const results: TSelect[] = [];
      for (const data of dataArray) {
        const record = await this.create(data, options);
        results.push(record);
      }
      return results;
    },

    // ========================================
    // FIND
    // ========================================
    async find(
      filter: WhereFilter<TSelect> = {},
      options?: QueryOptions<TSelect>,
    ): Promise<TSelect[]> {
      if (!options?.namespace) {
        throw new Error("namespace is required");
      }

      const { clause, params, paramIndex } = buildWhereClause(
        filter,
        options.namespace,
        name,
      );

      const orderClause = buildOrderClause(options?.sort);

      let limitClause = "";
      let paramIdx = paramIndex;
      if (options?.limit) {
        limitClause = `LIMIT $${paramIdx}`;
        params.push(options.limit);
        paramIdx++;
      }

      let offsetClause = "";
      if (options?.offset) {
        offsetClause = `OFFSET $${paramIdx}`;
        params.push(options.offset);
      }

      const result = await db.query<NodeRow>(
        `SELECT * FROM "nodes" WHERE ${clause} ${orderClause} ${limitClause} ${offsetClause}`,
        params,
      );

      let records = result.rows.map(mapNodeToRecord<TSelect>);

      if (options?.populate?.length) {
        records = await populateRelations(records, options.populate, options.namespace);
      }

      return records;
    },

    // ========================================
    // FIND ONE
    // ========================================
    async findOne(
      filter: WhereFilter<TSelect>,
      options?: Omit<QueryOptions<TSelect>, "limit" | "offset">,
    ): Promise<TSelect | null> {
      const results = await this.find(filter, { ...options, limit: 1 } as QueryOptions<TSelect>);
      return results[0] ?? null;
    },

    // ========================================
    // FIND BY ID
    // ========================================
    async findById(
      id: string,
      options: { namespace: string; populate?: string[] },
    ): Promise<TSelect | null> {
      const result = await db.query<NodeRow>(
        `SELECT * FROM "nodes" WHERE "id" = $1 AND "namespace" = $2 AND "type" = $3`,
        [id, options.namespace, name],
      );

      if (!result.rows[0]) return null;

      let records = [mapNodeToRecord<TSelect>(result.rows[0])];

      if (options.populate?.length) {
        records = await populateRelations(records, options.populate, options.namespace);
      }

      return records[0];
    },

    // ========================================
    // UPDATE
    // ========================================
    async update(
      filter: WhereFilter<TSelect>,
      data: Partial<TInsert>,
      options: { namespace: string },
    ): Promise<TSelect | null> {
      const existing = await this.findOne(filter, options);
      if (!existing) return null;

      const existingAny = existing as Record<string, unknown>;
      let updatedData = applyTimestamps({ ...existingAny, ...data }, true);

      // Run beforeUpdate hook
      if (hooks?.beforeUpdate) {
        updatedData = await hooks.beforeUpdate(updatedData, createHookContext(options.namespace));
      }

      const embedding = await generateEmbedding(updatedData);
      const searchContent = getSearchContent(updatedData);

      const result = await db.query<NodeRow>(
        `UPDATE "nodes" SET 
          "data" = $1,
          "name" = $2,
          "content" = $3,
          "embedding" = $4::vector,
          "updated_at" = NOW()
        WHERE "id" = $5 AND "namespace" = $6 AND "type" = $7
        RETURNING *`,
        [
          updatedData,
          String(updatedData.name ?? updatedData.id),
          searchContent,
          embedding ? `[${embedding.join(",")}]` : null,
          existingAny.id,
          options.namespace,
          name,
        ],
      );

      const record = result.rows[0] ? mapNodeToRecord<TSelect>(result.rows[0]) : null;

      // Run afterUpdate hook
      if (record && hooks?.afterUpdate) {
        await hooks.afterUpdate(record, createHookContext(options.namespace));
      }

      return record;
    },

    // ========================================
    // UPDATE MANY
    // ========================================
    async updateMany(
      filter: WhereFilter<TSelect>,
      data: Partial<TInsert>,
      options: { namespace: string },
    ): Promise<{ updated: number }> {
      const records = await this.find(filter, options as QueryOptions<TSelect>);
      let updated = 0;

      for (const record of records) {
        const recordAny = record as Record<string, unknown>;
        await this.update({ id: recordAny.id } as WhereFilter<TSelect>, data, options);
        updated++;
      }

      return { updated };
    },

    // ========================================
    // DELETE
    // ========================================
    async delete(
      filter: WhereFilter<TSelect>,
      options: { namespace: string },
    ): Promise<{ deleted: number }> {
      // Run beforeDelete hook
      if (hooks?.beforeDelete) {
        await hooks.beforeDelete(filter as Record<string, unknown>, createHookContext(options.namespace));
      }

      const { clause, params } = buildWhereClause(filter, options.namespace, name);

      const result = await db.query<{ count?: string }>(
        `WITH deleted AS (DELETE FROM "nodes" WHERE ${clause} RETURNING 1) SELECT COUNT(*) as count FROM deleted`,
        params,
      );

      const deleted = parseInt(result.rows[0]?.count ?? "0", 10);

      // Run afterDelete hook
      if (hooks?.afterDelete) {
        await hooks.afterDelete(deleted, createHookContext(options.namespace));
      }

      return { deleted };
    },

    // ========================================
    // DELETE MANY
    // ========================================
    deleteMany(
      filter: WhereFilter<TSelect>,
      options: { namespace: string },
    ): Promise<{ deleted: number }> {
      return this.delete(filter, options);
    },

    // ========================================
    // UPSERT
    // ========================================
    async upsert(
      filter: WhereFilter<TSelect>,
      data: TInsert,
      options: { namespace: string },
    ): Promise<TSelect> {
      const existing = await this.findOne(filter, options);

      if (existing) {
        const existingAny = existing as Record<string, unknown>;
        return (await this.update({ id: existingAny.id } as WhereFilter<TSelect>, data as Partial<TInsert>, options))!;
      }

      return this.create(data, options);
    },

    // ========================================
    // COUNT
    // ========================================
    async count(
      filter: WhereFilter<TSelect> = {},
      options?: { namespace: string },
    ): Promise<number> {
      if (!options?.namespace) {
        throw new Error("namespace is required");
      }

      const { clause, params } = buildWhereClause(filter, options.namespace, name);

      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM "nodes" WHERE ${clause}`,
        params,
      );

      return parseInt(result.rows[0]?.count ?? "0", 10);
    },

    // ========================================
    // EXISTS
    // ========================================
    async exists(
      filter: WhereFilter<TSelect>,
      options: { namespace: string },
    ): Promise<boolean> {
      const count = await this.count(filter, options);
      return count > 0;
    },
  };

  // ========================================
  // SEARCH (if enabled)
  // ========================================
  if (search?.enabled && embeddingFn) {
    crud.search = async (
      query: string,
      options: SearchOptions,
    ): Promise<Array<TSelect & { _similarity: number }>> => {
      const embedding = await embeddingFn(query);
      const limit = options.limit ?? 10;
      const threshold = options.threshold ?? 0.5;

      const params: unknown[] = [
        `[${embedding.join(",")}]`,
        options.namespace,
        name,
        threshold,
        limit,
      ];

      let whereClause = "";
      if (options.where && Object.keys(options.where).length > 0) {
        const { clause, params: whereParams } = buildWhereClause(
          options.where as WhereFilter<TSelect>,
          options.namespace,
          name,
          6, // Start after existing params
        );
        // Extract just data conditions
        const dataConditions = clause.split(" AND ").slice(2).join(" AND ");
        if (dataConditions) {
          whereClause = `AND ${dataConditions}`;
          params.push(...whereParams.slice(2));
        }
      }

      const result = await db.query<NodeRow & { similarity: number }>(
        `SELECT *, 1 - ("embedding" <=> $1::vector) as similarity
         FROM "nodes"
         WHERE "namespace" = $2
           AND "type" = $3
           AND "embedding" IS NOT NULL
           AND 1 - ("embedding" <=> $1::vector) > $4
           ${whereClause}
         ORDER BY "embedding" <=> $1::vector
         LIMIT $5`,
        params,
      );

      let records = result.rows.map((row) => ({
        ...mapNodeToRecord<TSelect>(row),
        _similarity: row.similarity,
      }));

      if (options.populate?.length) {
        records = (await populateRelations(
          records,
          options.populate,
          options.namespace,
        )) as Array<TSelect & { _similarity: number }>;
      }

      return records;
    };

    crud.findSimilar = async (
      id: string,
      options: { namespace: string; limit?: number; threshold?: number },
    ): Promise<Array<TSelect & { _similarity: number }>> => {
      // Get the source record's embedding
      const source = await db.query<NodeRow>(
        `SELECT "embedding" FROM "nodes" WHERE "id" = $1 AND "namespace" = $2 AND "type" = $3`,
        [id, options.namespace, name],
      );

      if (!source.rows[0]?.embedding) {
        return [];
      }

      const embedding = source.rows[0].embedding;
      const limit = options.limit ?? 10;
      const threshold = options.threshold ?? 0.5;

      const result = await db.query<NodeRow & { similarity: number }>(
        `SELECT *, 1 - ("embedding" <=> $1::vector) as similarity
         FROM "nodes"
         WHERE "namespace" = $2
           AND "type" = $3
           AND "id" != $4
           AND "embedding" IS NOT NULL
           AND 1 - ("embedding" <=> $1::vector) > $5
         ORDER BY "embedding" <=> $1::vector
         LIMIT $6`,
        [`[${embedding.join(",")}]`, options.namespace, name, id, threshold, limit],
      );

      return result.rows.map((row) => ({
        ...mapNodeToRecord<TSelect>(row),
        _similarity: row.similarity,
      }));
    };
  }

  return crud;
}

