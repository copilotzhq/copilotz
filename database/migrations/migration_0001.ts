export const generateMigrations = (): string => (`-- Enable extensions once; safe to re-run.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE IF NOT EXISTS "threads" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "description" text,
  "participants" jsonb,
  "initialMessage" text,
  "mode" varchar DEFAULT 'immediate' NOT NULL,
  "status" varchar DEFAULT 'active' NOT NULL,
  "summary" text,
  "parentThreadId" varchar(255),
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "events" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "threadId" varchar(255) NOT NULL,
  "eventType" varchar(64) NOT NULL,
  "payload" jsonb NOT NULL,
  "parentEventId" varchar(255),
  "traceId" varchar(255),
  "priority" integer,
  "ttlMs" integer,
  "expiresAt" timestamp,
  "namespace" varchar(255),
  "status" varchar DEFAULT 'pending' NOT NULL,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);


CREATE INDEX IF NOT EXISTS "idx_threads_external_id_active" ON "threads" ("externalId") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_threads_participants_gin" ON "threads" USING GIN ("participants");
CREATE INDEX IF NOT EXISTS "idx_events_thread_status" ON "events" ("threadId", "status");
CREATE INDEX IF NOT EXISTS "idx_events_pending_order" ON "events" (
  "threadId",
  (COALESCE("priority", 0)) DESC,
  "createdAt" ASC,
  "id" ASC
) WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS "idx_events_status_expires_at" ON "events" ("status", "expiresAt");
`);

// Re-export RAG migrations for unified migration runner
export { generateRagMigrations } from "./migration_0002_rag.ts";