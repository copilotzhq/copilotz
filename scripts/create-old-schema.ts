import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

console.log("Creating old schema (WITHOUT namespace in events)...");

// Create events table WITHOUT namespace column (simulating pre-0.12 schema)
await client.query(`
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
`);

// Create other required tables
await client.query(`
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

  CREATE TABLE IF NOT EXISTS "users" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "name" varchar(255),
    "email" varchar(255),
    "externalId" varchar(255),
    "metadata" jsonb,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );
`);

// Create index WITHOUT namespace (old style)
await client.query(`
  CREATE INDEX IF NOT EXISTS "idx_events_pending_order"
    ON "events" (
      "threadId",
      (COALESCE("priority", 0)) DESC,
      "createdAt" ASC,
      "id" ASC
    )
    WHERE "status" = 'pending';
`);

console.log("Old schema created (without namespace column)!");

// Verify
const result = await client.query(`
  SELECT column_name FROM information_schema.columns 
  WHERE table_name = 'events'
  ORDER BY ordinal_position;
`);
console.log("Events columns:", result.rows.map(r => r.column_name));

await client.end();

