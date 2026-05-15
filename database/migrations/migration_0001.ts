export const generateMigrations =
  (): string => (`-- Enable extensions once; safe to re-run.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE TABLE IF NOT EXISTS "threads" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "namespace" varchar(255),
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "description" text,
  "participants" jsonb,
  "initialMessage" text,
  "mode" varchar DEFAULT 'immediate' NOT NULL,
  "status" varchar DEFAULT 'active' NOT NULL,
  "summary" text,
  "parentThreadId" varchar(255),
  "rootThreadId" varchar(255),
  "lastEventId" varchar(255),
  "lastEventAt" timestamp,
  "workerLockedBy" varchar(255),
  "workerLeaseExpiresAt" timestamp,
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

/* Add namespace column to threads table */
ALTER TABLE "threads" ADD COLUMN IF NOT EXISTS "namespace" varchar(255);

/* Add namespace column to events table */
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "namespace" varchar(255);

CREATE INDEX IF NOT EXISTS "idx_threads_external_id_active" ON "threads" ("externalId") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_threads_namespace_external_id_active" ON "threads" ("namespace", "externalId") WHERE "status" = 'active';
CREATE INDEX IF NOT EXISTS "idx_threads_namespace_status" ON "threads" ("namespace", "status");
CREATE INDEX IF NOT EXISTS "idx_threads_participants_gin" ON "threads" USING GIN ("participants");
CREATE INDEX IF NOT EXISTS "threads_worker_lease_idx" ON "threads" ("workerLeaseExpiresAt", "workerLockedBy");
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
