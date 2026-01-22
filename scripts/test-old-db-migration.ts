/**
 * Test script to reproduce migration issues with older DB versions.
 * 
 * Step 1: Create a DB with old copilotz version (0.12.3)
 * Step 2: Manually run migrations one by one to find the problem
 * 
 * Run with: deno run -A scripts/test-old-db-migration.ts
 */

// Step 1: Import old copilotz to create DB with old schema
// We'll use dynamic import to switch between versions

// Use absolute path for PGlite file storage
const DB_PATH = Deno.cwd() + "/tmp/test-old-db";

async function cleanupDb() {
  try {
    await Deno.remove(DB_PATH, { recursive: true });
    console.log("✓ Cleaned up old test DB");
  } catch {
    // Ignore if doesn't exist
  }
}

async function step1_createOldDb() {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 1: Creating SIMULATED old DB (events table WITHOUT namespace)");
  console.log("=".repeat(60) + "\n");

  // Connect with Ominipg directly to create a minimal old-style DB
  const { Ominipg } = await import("omnipg");
  
  const db = await Ominipg.connect({
    url: `file://${DB_PATH}`,
    schemas: {},
    schemaSQL: [], // No migrations - we'll create tables manually
  });

  console.log("✓ Connected to fresh DB at:", DB_PATH);
  
  // Create ONLY the essential tables that would exist in old versions
  // WITHOUT the namespace column in events
  const oldSchema = `
    CREATE EXTENSION IF NOT EXISTS "pg_trgm";
    
    CREATE TABLE IF NOT EXISTS "threads" (
      "id" varchar(255) PRIMARY KEY NOT NULL,
      "name" varchar(255) NOT NULL,
      "externalId" varchar(255),
      "status" varchar DEFAULT 'active' NOT NULL,
      "createdAt" timestamp DEFAULT now() NOT NULL,
      "updatedAt" timestamp DEFAULT now() NOT NULL
    );
    
    CREATE TABLE IF NOT EXISTS "users" (
      "id" varchar(255) PRIMARY KEY NOT NULL,
      "name" varchar(255),
      "email" varchar(255),
      "externalId" varchar(255),
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
    
    CREATE TABLE IF NOT EXISTS "messages" (
      "id" varchar(255) PRIMARY KEY NOT NULL,
      "threadId" varchar(255) NOT NULL,
      "senderId" text NOT NULL,
      "senderType" varchar NOT NULL,
      "content" text,
      "createdAt" timestamp DEFAULT now() NOT NULL,
      "updatedAt" timestamp DEFAULT now() NOT NULL
    );
    
    -- Create some basic indexes (old version style)
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

  // Execute each statement
  const statements = oldSchema.split(';').filter(s => s.trim());
  for (const stmt of statements) {
    try {
      await db.query(stmt + ';');
    } catch (e) {
      console.log("Note:", (e as Error).message);
    }
  }

  // Verify events table structure
  const eventsColumns = await db.query(
    `SELECT column_name FROM information_schema.columns 
     WHERE table_name = 'events'
     ORDER BY ordinal_position`
  );
  console.log("\n📋 Events table columns (simulated OLD schema):");
  for (const row of eventsColumns.rows) {
    console.log("  -", (row as { column_name: string }).column_name);
  }

  // Verify namespace is NOT present
  const hasNamespace = eventsColumns.rows.some(
    (r: unknown) => (r as { column_name: string }).column_name === 'namespace'
  );
  console.log("\n✓ namespace column exists:", hasNamespace ? "YES (ERROR!)" : "NO (correct)");

  console.log("\n✓ Old DB simulation complete - now run step2 to test migrations");
  return db;
}

async function step2_runMigrationsManually() {
  console.log("\n" + "=".repeat(60));
  console.log("STEP 2: Running migrations manually one by one");
  console.log("=".repeat(60) + "\n");

  // Import current migrations
  const { generateMigrations } = await import("../database/migrations/migration_0001.ts");
  const { generateRagMigrations } = await import("../database/migrations/migration_0002_rag.ts");
  const { generateKnowledgeGraphMigrations } = await import("../database/migrations/migration_0003_knowledge_graph.ts");
  const { generateUlidSupportMigrations } = await import("../database/migrations/migration_0004_ulid_support.ts");
  const { generateNamespaceEventsMigrations } = await import("../database/migrations/migration_0005_namespace_events.ts");
  const { splitSQLStatements } = await import("../database/migrations/utils.ts");

  // IMPORTANT: Print all statements with their index to see exact order
  console.log("=== FULL STATEMENT ORDER ===\n");
  const allMigrations = generateMigrations() + "\n" + generateRagMigrations() + "\n" + 
    generateKnowledgeGraphMigrations() + "\n" + generateUlidSupportMigrations() + "\n" + 
    generateNamespaceEventsMigrations();
  const allStatements = splitSQLStatements(allMigrations);
  
  // Find statements that reference 'namespace' in events context
  allStatements.forEach((stmt, i) => {
    if (stmt.toLowerCase().includes('namespace') && stmt.toLowerCase().includes('event')) {
      console.log(`[${i}] ${stmt.substring(0, 100)}...`);
    }
  });
  console.log("\n");

  // Connect to the existing DB directly with omnipg
  const { Ominipg } = await import("omnipg");
  
  const db = await Ominipg.connect({
    url: `file://${DB_PATH}`,  // PGlite file:// format
    schemas: {},
    schemaSQL: [], // Don't run any migrations yet
  });

  console.log("✓ Connected to old DB\n");

  // Check current events table state
  const eventsCheck = await db.query(
    `SELECT column_name FROM information_schema.columns 
     WHERE table_name = 'events' AND column_name = 'namespace'`
  );
  console.log("📋 Does 'namespace' column exist in events?", eventsCheck.rows.length > 0 ? "YES" : "NO");

  // Migrations to test
  const migrations = [
    { name: "migration_0001 (base)", sql: generateMigrations() },
    { name: "migration_0002 (rag)", sql: generateRagMigrations() },
    { name: "migration_0003 (knowledge_graph)", sql: generateKnowledgeGraphMigrations() },
    { name: "migration_0004 (ulid_support)", sql: generateUlidSupportMigrations() },
    { name: "migration_0005 (namespace_events)", sql: generateNamespaceEventsMigrations() },
  ];

  for (const migration of migrations) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`Testing: ${migration.name}`);
    console.log("─".repeat(50));

    const statements = splitSQLStatements(migration.sql);
    console.log(`  Total statements: ${statements.length}`);

    let successCount = 0;
    let errorCount = 0;

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      const preview = stmt.substring(0, 80).replace(/\n/g, " ") + (stmt.length > 80 ? "..." : "");
      
      try {
        await db.query(stmt);
        successCount++;
        // console.log(`  ✓ [${i + 1}] ${preview}`);
      } catch (error) {
        errorCount++;
        console.log(`  ✗ [${i + 1}] ${preview}`);
        console.log(`    ERROR: ${(error as Error).message}`);
        console.log(`    FULL STATEMENT:\n${stmt}\n`);
      }
    }

    console.log(`  Summary: ${successCount} succeeded, ${errorCount} failed`);
  }

  // Final check
  console.log("\n" + "=".repeat(60));
  console.log("FINAL STATE CHECK");
  console.log("=".repeat(60) + "\n");

  const finalEventsCheck = await db.query(
    `SELECT column_name, data_type FROM information_schema.columns 
     WHERE table_name = 'events'
     ORDER BY ordinal_position`
  );
  console.log("📋 Events table columns after migrations:");
  for (const row of finalEventsCheck.rows) {
    const col = row as { column_name: string; data_type: string };
    console.log(`  - ${col.column_name}: ${col.data_type}`);
  }

  return db;
}

async function main() {
  const args = Deno.args;
  
  if (args.includes("--clean")) {
    await cleanupDb();
  }

  if (args.includes("--step1") || args.length === 0) {
    await step1_createOldDb();
  }

  if (args.includes("--step2") || args.length === 0) {
    await step2_runMigrationsManually();
  }

  console.log("\n✓ Done!");
  Deno.exit(0);
}

main().catch(console.error);

