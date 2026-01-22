export const generateMigrations = (): string => (`-- Enable extensions once; safe to re-run.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "vector";

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

-- CRITICAL: Add namespace column to existing events tables FIRST
-- This must run BEFORE any index creation that might reference namespace
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables 
    WHERE table_schema = current_schema() AND table_name = 'events'
  ) THEN
    -- Add namespace column if not exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = current_schema() 
        AND table_name = 'events' 
        AND column_name = 'namespace'
    ) THEN
      ALTER TABLE "events" ADD COLUMN "namespace" VARCHAR(255);
    END IF;
    -- Add other potentially missing columns
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = current_schema() 
        AND table_name = 'events' 
        AND column_name = 'ttlMs'
    ) THEN
      ALTER TABLE "events" ADD COLUMN "ttlMs" INTEGER;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = current_schema() 
        AND table_name = 'events' 
        AND column_name = 'expiresAt'
    ) THEN
      ALTER TABLE "events" ADD COLUMN "expiresAt" TIMESTAMP;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_schema = current_schema() 
        AND table_name = 'events' 
        AND column_name = 'metadata'
    ) THEN
      ALTER TABLE "events" ADD COLUMN "metadata" JSONB;
    END IF;
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
  "namespace" varchar(255),
  "status" varchar DEFAULT 'pending' NOT NULL,
  "metadata" jsonb,
  "createdAt" timestamp DEFAULT now() NOT NULL,
  "updatedAt" timestamp DEFAULT now() NOT NULL
);

/* Note: Column additions (ttlMs, expiresAt, metadata, namespace) are handled
   by the DO block at the top of this migration for better compatibility
   with existing databases that may have the events table without these columns. */

/* Foreign keys wrapped in DO blocks to prevent transaction abort on failure */
DO $$
BEGIN
  -- Drop old constraint naming variants
  ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_thread_id_threads_id_fk";
  ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_threadId_threads_id_fk";
  
  -- Add FK constraint only if both table and column exist
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() 
      AND table_name = 'messages' 
      AND column_name = 'threadId'
  ) THEN
    BEGIN
      ALTER TABLE "messages"
        ADD CONSTRAINT "messages_threadId_threads_id_fk"
        FOREIGN KEY ("threadId") REFERENCES "threads"("id")
        ON DELETE NO ACTION ON UPDATE NO ACTION;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'FK messages_threadId_threads_id_fk not added: %', SQLERRM;
    END;
  END IF;
END $$;

DO $$
BEGIN
  -- Drop old constraint naming variants
  ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_sender_user_id_users_id_fk";
  ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_senderUserId_users_id_fk";
  
  -- Add FK constraint only if both table and column exist
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = current_schema() 
      AND table_name = 'messages' 
      AND column_name = 'senderUserId'
  ) THEN
    BEGIN
      ALTER TABLE "messages"
        ADD CONSTRAINT "messages_senderUserId_users_id_fk"
        FOREIGN KEY ("senderUserId") REFERENCES "users"("id")
        ON DELETE NO ACTION ON UPDATE NO ACTION;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'FK messages_senderUserId_users_id_fk not added: %', SQLERRM;
    END;
  END IF;
END $$;

/* Indexes wrapped in DO blocks to prevent transaction abort on failure */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_threads_external_id_active') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'threads' AND column_name = 'externalId') THEN
      CREATE INDEX "idx_threads_external_id_active" ON "threads" ("externalId") WHERE "status" = 'active';
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_threads_external_id_active not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_threads_participants_gin') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'threads' AND column_name = 'participants') THEN
      CREATE INDEX "idx_threads_participants_gin" ON "threads" USING GIN ("participants");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_threads_participants_gin not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_messages_thread_id_created_at') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'messages' AND column_name = 'threadId') THEN
      CREATE INDEX "idx_messages_thread_id_created_at" ON "messages" ("threadId", "createdAt");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_messages_thread_id_created_at not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_events_thread_status') THEN
    CREATE INDEX "idx_events_thread_status" ON "events" ("threadId", "status");
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_events_thread_status not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_events_pending_order') THEN
    CREATE INDEX "idx_events_pending_order" ON "events" (
      "threadId",
      (COALESCE("priority", 0)) DESC,
      "createdAt" ASC,
      "id" ASC
    ) WHERE "status" = 'pending';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_events_pending_order not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_events_status_expires_at') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'events' AND column_name = 'expiresAt') THEN
      CREATE INDEX "idx_events_status_expires_at" ON "events" ("status", "expiresAt");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'idx_events_status_expires_at not created: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_agents_name') THEN
    CREATE INDEX "idx_agents_name" ON "agents" ("name");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_agents_external_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'externalId') THEN
      CREATE INDEX "idx_agents_external_id" ON "agents" ("externalId");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_apis_name') THEN
    CREATE INDEX "idx_apis_name" ON "apis" ("name");
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_apis_external_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'apis' AND column_name = 'externalId') THEN
      CREATE INDEX "idx_apis_external_id" ON "apis" ("externalId");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_tools_external_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tools' AND column_name = 'externalId') THEN
      CREATE INDEX "idx_tools_external_id" ON "tools" ("externalId");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_users_external_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'externalId') THEN
      CREATE INDEX "idx_users_external_id" ON "users" ("externalId");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'idx_users_email') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'email') THEN
      CREATE INDEX "idx_users_email" ON "users" ("email");
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;`);

// Re-export RAG migrations for unified migration runner
export { generateRagMigrations } from "./migration_0002_rag.ts";