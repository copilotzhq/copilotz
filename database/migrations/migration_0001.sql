-- Enable extensions once; safe to re-run.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- If legacy "queue" table exists (and new 'events' doesn't), drop Copilotz tables to recreate with new schema
DO $$
BEGIN
IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'queue')
   AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'events') THEN
  -- Drop in dependency-safe order
  DROP TABLE IF EXISTS "messages";
  DROP TABLE IF EXISTS "queue";
  DROP TABLE IF EXISTS "threads";
  DROP TABLE IF EXISTS "tasks";
  DROP TABLE IF EXISTS "agents";
  DROP TABLE IF EXISTS "tools";
  DROP TABLE IF EXISTS "mcpServers";
  DROP TABLE IF EXISTS "users";
  DROP TABLE IF EXISTS "apis";
END IF;
END $$;

CREATE TABLE IF NOT EXISTS "agents" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "role" text NOT NULL,
  "personality" text,
  "instructions" text,
  "description" text,
  "agentType" varchar DEFAULT 'agentic' NOT NULL,
  "allowedAgents" jsonb,
  "allowedTools" jsonb,
  "llmOptions" jsonb,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "tools" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "key" varchar(255) NOT NULL,
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "description" text NOT NULL,
  "inputSchema" jsonb,
  "outputSchema" jsonb,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "tools_name_unique" UNIQUE("name"),
  CONSTRAINT "tools_key_unique" UNIQUE("key")
);

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

CREATE TABLE IF NOT EXISTS "tasks" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "goal" text NOT NULL,
  "successCriteria" text,
  "status" varchar DEFAULT 'pending' NOT NULL,
  "notes" text,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "messages" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "threadId" varchar(255) NOT NULL,
  "senderUserId" varchar(255),
  "senderId" text NOT NULL,
  "senderType" varchar NOT NULL,
  "externalId" varchar(255),
  "content" text,
  "toolCalls" jsonb,
  "toolCallId" varchar(255),
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "mcpServers" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "description" text,
  "transport" jsonb,
  "capabilities" jsonb,
  "env" jsonb,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255),
  "email" varchar(255),
  "externalId" varchar(255),
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "apis" (
  "id" varchar(255) PRIMARY KEY NOT NULL,
  "name" varchar(255) NOT NULL,
  "externalId" varchar(255),
  "description" text,
  "openApiSchema" jsonb,
  "baseUrl" text,
  "headers" jsonb,
  "auth" jsonb,
  "timeout" integer,
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
  "status" varchar DEFAULT 'pending' NOT NULL,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE IF EXISTS "events"
  ADD COLUMN IF NOT EXISTS "ttlMs" integer;

ALTER TABLE IF EXISTS "events"
  ADD COLUMN IF NOT EXISTS "expiresAt" timestamp;

ALTER TABLE IF EXISTS "events"
  ADD COLUMN IF NOT EXISTS "metadata" jsonb;

/* Foreign keys rewritten without DO blocks */
ALTER TABLE "messages"
  DROP CONSTRAINT IF EXISTS "messages_thread_id_threads_id_fk";
ALTER TABLE "messages"
  DROP CONSTRAINT IF EXISTS "messages_threadId_threads_id_fk";

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_threadId_threads_id_fk"
  FOREIGN KEY ("threadId") REFERENCES "threads"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "messages"
  DROP CONSTRAINT IF EXISTS "messages_sender_user_id_users_id_fk";
ALTER TABLE "messages"
  DROP CONSTRAINT IF EXISTS "messages_senderUserId_users_id_fk";

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_senderUserId_users_id_fk"
  FOREIGN KEY ("senderUserId") REFERENCES "users"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX IF NOT EXISTS "idx_threads_external_id_active"
  ON "threads" ("externalId")
  WHERE "status" = 'active';

CREATE INDEX IF NOT EXISTS "idx_threads_participants_gin"
  ON "threads" USING GIN ("participants");

CREATE INDEX IF NOT EXISTS "idx_messages_thread_id_created_at"
  ON "messages" ("threadId", "createdAt");

CREATE INDEX IF NOT EXISTS "idx_events_thread_status"
  ON "events" ("threadId", "status");

CREATE INDEX IF NOT EXISTS "idx_events_pending_order"
  ON "events" (
    "threadId",
    (COALESCE("priority", 0)) DESC,
    "createdAt" ASC,
    "id" ASC
  )
  WHERE "status" = 'pending';

CREATE INDEX IF NOT EXISTS "idx_events_status_expires_at"
  ON "events" ("status", "expiresAt");

CREATE INDEX IF NOT EXISTS "idx_agents_name"
  ON "agents" ("name");

CREATE INDEX IF NOT EXISTS "idx_agents_external_id"
  ON "agents" ("externalId");

CREATE INDEX IF NOT EXISTS "idx_apis_name"
  ON "apis" ("name");

CREATE INDEX IF NOT EXISTS "idx_apis_external_id"
  ON "apis" ("externalId");

CREATE INDEX IF NOT EXISTS "idx_tools_external_id"
  ON "tools" ("externalId");

CREATE INDEX IF NOT EXISTS "idx_users_external_id"
  ON "users" ("externalId");

CREATE INDEX IF NOT EXISTS "idx_users_email"
  ON "users" ("email");`