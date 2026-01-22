/**
 * Test script to reproduce migration issues from older DB versions.
 * 
 * Step 1: Run with --init to create a DB simulating old v0.12.3 schema (no namespace)
 * Step 2: Run with --migrate to test migrations one by one
 * 
 * Usage:
 *   deno run -A scripts/test-migration-upgrade.ts --init
 *   deno run -A scripts/test-migration-upgrade.ts --migrate
 *   deno run -A scripts/test-migration-upgrade.ts --check
 * 
 * Note: This requires a PostgreSQL database. Set DATABASE_URL env var or use default localhost.
 */

// Use real Postgres for testing
const DATABASE_URL = Deno.env.get("DATABASE_URL") || "postgres://postgres:postgres@localhost:5432/copilotz_test";

console.log("Using database:", DATABASE_URL.replace(/:[^:@]+@/, ":***@"));

// Old v0.12.3 schema - events table WITHOUT namespace column
const OLD_SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

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

-- OLD events table WITHOUT namespace, ttlMs, expiresAt, metadata columns
CREATE TABLE IF NOT EXISTS "events" (
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

-- Old indexes (WITHOUT namespace)
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
`;

// ============================================
// STEP 1: Initialize with old schema (simulating v0.12.3)
// ============================================
async function initOldDb() {
  console.log("🔧 Initializing database with OLD schema (no namespace)...\n");
  
  // Remove old test DB
  try {
    await Deno.remove(DB_PATH, { recursive: true });
    console.log("Removed existing test DB\n");
  } catch {
    // Ignore if doesn't exist
  }
  
  const { PGlite } = await import("npm:@electric-sql/pglite@0.2.17");
  
  const db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;
  
  // Apply old schema
  console.log("📝 Applying old schema...\n");
  const statements = OLD_SCHEMA_SQL.split(";").filter(s => s.trim().length > 0);
  
  for (const stmt of statements) {
    try {
      await db.query(stmt + ";");
      const preview = stmt.trim().substring(0, 60).replace(/\n/g, " ");
      console.log(`✅ ${preview}...`);
    } catch (error) {
      console.log(`❌ Failed: ${(error as Error).message}`);
    }
  }
  
  // Insert test data
  console.log("\n📝 Inserting test data...\n");
  
  await db.query(`INSERT INTO "threads" (id, name, status) VALUES ('test-thread-1', 'Test Thread', 'active')`);
  console.log("✅ Created thread");
  
  await db.query(`INSERT INTO "events" (id, "threadId", "eventType", payload, status) VALUES ('test-event-1', 'test-thread-1', 'NEW_MESSAGE', '{"content": "test"}', 'pending')`);
  console.log("✅ Created event (without namespace)");
  
  await db.close();
  
  console.log("\n✅ Old database initialized at:", DB_PATH);
  console.log("Now run with --check to verify schema, then --migrate to test migrations");
}

// ============================================
// STEP 2: Check current DB schema
// ============================================
async function checkSchema() {
  console.log("🔍 Checking current database schema...\n");
  
  const { PGlite } = await import("npm:@electric-sql/pglite@0.2.17");
  
  const db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;
  
  // Check events table columns
  const eventsColumns = await db.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns 
    WHERE table_name = 'events'
    ORDER BY ordinal_position
  `);
  
  console.log("📋 Events table columns:");
  for (const row of eventsColumns.rows) {
    const r = row as { column_name: string; data_type: string; is_nullable: string };
    console.log(`  - ${r.column_name}: ${r.data_type} (nullable: ${r.is_nullable})`);
  }
  
  // Check for namespace column specifically
  const hasNamespace = eventsColumns.rows.some(
    (r) => (r as { column_name: string }).column_name === "namespace"
  );
  console.log(`\n🔑 Has 'namespace' column: ${hasNamespace ? "✅ YES" : "❌ NO"}`);
  
  // Check indexes
  const indexes = await db.query(`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'events'
  `);
  
  console.log("\n📋 Events table indexes:");
  for (const row of indexes.rows) {
    const r = row as { indexname: string };
    console.log(`  - ${r.indexname}`);
  }
  
  // List all tables
  const tables = await db.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public'
    ORDER BY table_name
  `);
  
  console.log("\n📋 All tables:");
  for (const row of tables.rows) {
    const r = row as { table_name: string };
    console.log(`  - ${r.table_name}`);
  }
  
  await db.close();
}

// ============================================
// STEP 3: Test migrations one by one
// ============================================
async function testMigrations() {
  console.log("🔄 Testing migrations one by one...\n");
  
  const { PGlite } = await import("npm:@electric-sql/pglite@0.2.17");
  
  // Import migration generators from local files
  const { generateMigrations } = await import("../database/migrations/migration_0001.ts");
  const { generateRagMigrations } = await import("../database/migrations/migration_0002_rag.ts");
  const { generateKnowledgeGraphMigrations } = await import("../database/migrations/migration_0003_knowledge_graph.ts");
  const { generateUlidSupportMigrations } = await import("../database/migrations/migration_0004_ulid_support.ts");
  const { generateNamespaceEventsMigrations } = await import("../database/migrations/migration_0005_namespace_events.ts");
  const { splitSQLStatements } = await import("../database/migrations/utils.ts");
  
  const db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;
  
  const migrations = [
    { name: "migration_0001 (base)", sql: generateMigrations() },
    { name: "migration_0002 (rag)", sql: generateRagMigrations() },
    { name: "migration_0003 (knowledge graph)", sql: generateKnowledgeGraphMigrations() },
    { name: "migration_0004 (ulid support)", sql: generateUlidSupportMigrations() },
    { name: "migration_0005 (namespace events)", sql: generateNamespaceEventsMigrations() },
  ];
  
  for (const migration of migrations) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📦 Testing: ${migration.name}`);
    console.log(`${"=".repeat(60)}`);
    
    const statements = splitSQLStatements(migration.sql);
    console.log(`Found ${statements.length} statements\n`);
    
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const preview = stmt.substring(0, 80).replace(/\n/g, " ") + (stmt.length > 80 ? "..." : "");
      
      console.log(`\n[${i + 1}/${statements.length}] ${preview}`);
      
      try {
        await db.query(stmt);
        console.log(`   ✅ OK`);
      } catch (error) {
        console.log(`   ❌ FAILED: ${(error as Error).message}`);
        console.log(`\n   Full statement:\n   ${stmt.split("\n").join("\n   ")}`);
        
        // Ask if we should continue
        const shouldContinue = confirm("\n   Continue with next statement?");
        if (!shouldContinue) {
          console.log("\n🛑 Stopped by user");
          await db.close();
          return;
        }
      }
    }
  }
  
  console.log("\n\n✅ All migrations tested!");
  await db.close();
}

// ============================================
// STEP 4: Run individual statement
// ============================================
async function runStatement(sql: string) {
  const { PGlite } = await import("npm:@electric-sql/pglite@0.2.17");
  
  const db = new PGlite(`file://${DB_PATH}`);
  await db.waitReady;
  
  try {
    console.log("Running SQL:", sql.substring(0, 100) + "...");
    await db.query(sql);
    console.log("✅ Success");
  } catch (error) {
    console.log("❌ Failed:", (error as Error).message);
  }
  
  await db.close();
}

// ============================================
// Main
// ============================================
const args = Deno.args;

if (args.includes("--init")) {
  await initOldDb();
} else if (args.includes("--check")) {
  await checkSchema();
} else if (args.includes("--migrate")) {
  await testMigrations();
} else if (args.includes("--run")) {
  const sqlIndex = args.indexOf("--run") + 1;
  if (args[sqlIndex]) {
    await runStatement(args[sqlIndex]);
  } else {
    console.log("Usage: --run 'SQL STATEMENT'");
  }
} else {
  console.log(`
Usage:
  deno run -A scripts/test-migration-upgrade.ts --init     # Create old DB with v0.12.3
  deno run -A scripts/test-migration-upgrade.ts --check    # Check current schema
  deno run -A scripts/test-migration-upgrade.ts --migrate  # Test migrations one by one
  deno run -A scripts/test-migration-upgrade.ts --run 'SQL' # Run a single SQL statement
`);
}

