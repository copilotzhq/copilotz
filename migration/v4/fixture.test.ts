import type { SqlSession } from "../../runtime/events/session.ts";
import {
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../../runtime/events/schema.ts";

/** Exact released 0.47/0.48 column profile; migration tests add only data. */
export async function provisionLegacyGraphV1Fixture(
  session: SqlSession,
  schema = "public",
): Promise<void> {
  const qualifiedSchema = quoteEventIdentifier(validateEventSchemaName(schema));
  await session.query(`CREATE SCHEMA IF NOT EXISTS ${qualifiedSchema}`);
  await session.query(`CREATE TABLE ${qualifiedSchema}.threads (
    "id" varchar PRIMARY KEY, "namespace" varchar, "name" varchar NOT NULL,
    "externalId" varchar, "description" text, "participants" jsonb, "initialMessage" text,
    "mode" varchar NOT NULL DEFAULT 'immediate', "status" varchar NOT NULL DEFAULT 'active',
    "summary" text, "parentThreadId" varchar, "rootThreadId" varchar, "lastEventId" varchar,
    "lastEventAt" timestamp, "workerLockedBy" varchar, "workerLeaseExpiresAt" timestamp,
    "createdAt" timestamp NOT NULL DEFAULT now(), "updatedAt" timestamp NOT NULL DEFAULT now()
  )`);
  await session.query(`CREATE TABLE ${qualifiedSchema}.nodes (
    id text PRIMARY KEY, namespace text NOT NULL, type text NOT NULL, name text NOT NULL,
    embedding jsonb, content text, data jsonb DEFAULT '{}'::jsonb, source_type text, source_id text,
    created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  )`);
  await session.query(`CREATE TABLE ${qualifiedSchema}.edges (
    id text PRIMARY KEY, source_node_id text NOT NULL REFERENCES ${qualifiedSchema}.nodes(id) ON DELETE CASCADE,
    target_node_id text NOT NULL REFERENCES ${qualifiedSchema}.nodes(id) ON DELETE CASCADE, type text NOT NULL,
    data jsonb DEFAULT '{}'::jsonb, weight double precision DEFAULT 1.0, created_at timestamptz DEFAULT now()
  )`);
  await session.query(`CREATE TABLE ${qualifiedSchema}.events (
    id varchar PRIMARY KEY, "threadId" varchar NOT NULL, "eventType" varchar NOT NULL, payload jsonb NOT NULL,
    "parentEventId" varchar, "traceId" varchar, priority integer, "ttlMs" integer, "expiresAt" timestamp,
    namespace varchar, status varchar NOT NULL DEFAULT 'pending', metadata jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
    "updatedAt" timestamp NOT NULL DEFAULT now(), "subjectType" varchar, "subjectId" varchar, operation varchar,
    "causationId" varchar, "correlationId" varchar, "dedupeKey" varchar, input jsonb, before jsonb, after jsonb, patch jsonb
  )`);
}
