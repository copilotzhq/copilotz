import { quoteEventIdentifier } from "../../runtime/events/index.ts";
import type { SqlSession } from "../../runtime/events/index.ts";

/**
 * Minimal final-v1 schema used only to prove the one-way upgrader.
 * It deliberately contains no v1 runtime, operations, workers, or loaders.
 */
export async function provisionV1FixtureSchema(
  session: SqlSession,
  schema: string,
): Promise<void> {
  const namespace = quoteEventIdentifier(schema);
  await session.query(`CREATE SCHEMA IF NOT EXISTS ${namespace}`);
  const tables = [
    `CREATE TABLE ${namespace}."threads" (
      "id" VARCHAR PRIMARY KEY,
      "namespace" VARCHAR,
      "name" VARCHAR NOT NULL,
      "externalId" VARCHAR,
      "description" TEXT,
      "participants" JSONB,
      "initialMessage" TEXT,
      "mode" VARCHAR NOT NULL DEFAULT 'immediate',
      "status" VARCHAR NOT NULL DEFAULT 'active',
      "summary" TEXT,
      "parentThreadId" VARCHAR,
      "rootThreadId" VARCHAR,
      "lastEventId" VARCHAR,
      "lastEventAt" TIMESTAMP,
      "runGeneration" INTEGER NOT NULL DEFAULT 0,
      "workerLockedBy" VARCHAR,
      "workerLeaseExpiresAt" TIMESTAMP,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE ${namespace}."nodes" (
      "id" TEXT PRIMARY KEY,
      "namespace" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "embedding" JSONB,
      "content" TEXT,
      "data" JSONB DEFAULT '{}'::jsonb,
      "source_type" TEXT,
      "source_id" TEXT,
      "created_at" TIMESTAMPTZ DEFAULT NOW(),
      "updated_at" TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE ${namespace}."edges" (
      "id" TEXT PRIMARY KEY,
      "source_node_id" TEXT NOT NULL,
      "target_node_id" TEXT NOT NULL,
      "type" TEXT NOT NULL,
      "data" JSONB DEFAULT '{}'::jsonb,
      "weight" DOUBLE PRECISION DEFAULT 1.0,
      "created_at" TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE ${namespace}."events" (
      "id" VARCHAR PRIMARY KEY,
      "threadId" VARCHAR NOT NULL,
      "eventType" VARCHAR NOT NULL,
      "payload" JSONB NOT NULL,
      "parentEventId" VARCHAR,
      "traceId" VARCHAR,
      "runGeneration" INTEGER,
      "priority" INTEGER,
      "ttlMs" INTEGER,
      "expiresAt" TIMESTAMP,
      "namespace" VARCHAR,
      "status" VARCHAR NOT NULL DEFAULT 'pending',
      "metadata" JSONB,
      "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
      "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
      "subjectType" VARCHAR,
      "subjectId" VARCHAR,
      "operation" VARCHAR,
      "causationId" VARCHAR,
      "correlationId" VARCHAR,
      "dedupeKey" VARCHAR,
      "input" JSONB,
      "before" JSONB,
      "after" JSONB,
      "patch" JSONB
    )`,
  ];
  for (const statement of tables) await session.query(statement);
}
