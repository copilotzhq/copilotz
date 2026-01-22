import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

console.log("Dropping all copilotz tables...");
await client.query(`
  DROP TABLE IF EXISTS "edges" CASCADE;
  DROP TABLE IF EXISTS "nodes" CASCADE;
  DROP TABLE IF EXISTS "document_chunks" CASCADE;
  DROP TABLE IF EXISTS "documents" CASCADE;
  DROP TABLE IF EXISTS "messages" CASCADE;
  DROP TABLE IF EXISTS "events" CASCADE;
  DROP TABLE IF EXISTS "threads" CASCADE;
  DROP TABLE IF EXISTS "tasks" CASCADE;
  DROP TABLE IF EXISTS "agents" CASCADE;
  DROP TABLE IF EXISTS "tools" CASCADE;
  DROP TABLE IF EXISTS "mcpServers" CASCADE;
  DROP TABLE IF EXISTS "users" CASCADE;
  DROP TABLE IF EXISTS "apis" CASCADE;
  DROP TABLE IF EXISTS "queue" CASCADE;
`);

console.log("Creating OLD schema (simulating pre-namespace database)...");

// Create events table WITHOUT namespace column (like old version)
await client.query(`
  CREATE TABLE "events" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "threadId" varchar(255) NOT NULL,
    "eventType" varchar(64) NOT NULL,
    "payload" jsonb NOT NULL,
    "parentEventId" varchar(255),
    "traceId" varchar(255),
    "priority" integer,
    "status" varchar DEFAULT 'pending' NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );
`);

// Create old nodes/edges with UUID (simulating pre-ULID database)
await client.query(`
  CREATE TABLE "nodes" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "namespace" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT,
    "data" JSONB DEFAULT '{}',
    "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );
  
  CREATE TABLE "edges" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "source_node_id" UUID NOT NULL,
    "target_node_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB DEFAULT '{}',
    "weight" FLOAT DEFAULT 1.0,
    "created_at" TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  );
`);

// Create other required tables
await client.query(`
  CREATE TABLE IF NOT EXISTS "agents" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "name" varchar(255) NOT NULL,
    "role" text NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "threads" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "name" varchar(255) NOT NULL,
    "status" varchar DEFAULT 'active' NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "messages" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "threadId" varchar(255) NOT NULL,
    "senderId" text NOT NULL,
    "senderType" varchar NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS "users" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );
`);

console.log("\n=== Old schema created ===");
console.log("Events columns:", (await client.query(`
  SELECT column_name FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'events';
`)).rows.map(r => r.column_name));

console.log("Nodes.id type:", (await client.query(`
  SELECT data_type FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'nodes' AND column_name = 'id';
`)).rows[0]?.data_type);

await client.end();
console.log("\nOld schema ready for testing!");

