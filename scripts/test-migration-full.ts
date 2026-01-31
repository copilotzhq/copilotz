import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// Check PostgreSQL version
console.log("=== PostgreSQL Version ===");
const versionResult = await client.query(`SELECT version();`);
console.log(versionResult.rows[0].version);

// Drop events table
console.log("\n=== Dropping events table ===");
await client.query(`DROP TABLE IF EXISTS "events" CASCADE;`);

// Create events table WITHOUT namespace (like old version)
console.log("Creating events WITHOUT namespace...");
await client.query(`
  CREATE TABLE "events" (
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

// Create old index (without namespace)
console.log("Creating old index (without namespace)...");
await client.query(`
  CREATE INDEX "idx_events_pending_order"
    ON "events" (
      "threadId",
      (COALESCE("priority", 0)) DESC,
      "createdAt" ASC,
      "id" ASC
    )
    WHERE "status" = 'pending';
`);

// Verify state
console.log("\n=== Before migration ===");
const beforeCols = await client.query(`
  SELECT column_name FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'events';
`);
console.log("Columns:", beforeCols.rows.map(r => r.column_name));

// Now run migrations EXACTLY as they would be run by Ominipg (one statement at a time)
console.log("\n=== Running migrations one by one ===\n");

const migrations = [
  // From migration_0001 - CREATE TABLE (will be skipped since table exists)
  `CREATE TABLE IF NOT EXISTS "events" (
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
  );`,
  
  // From migration_0001 - ALTER TABLE to add columns
  `ALTER TABLE IF EXISTS "events" ADD COLUMN IF NOT EXISTS "ttlMs" integer;`,
  `ALTER TABLE IF EXISTS "events" ADD COLUMN IF NOT EXISTS "expiresAt" timestamp;`,
  `ALTER TABLE IF EXISTS "events" ADD COLUMN IF NOT EXISTS "metadata" jsonb;`,
  `ALTER TABLE IF EXISTS "events" ADD COLUMN IF NOT EXISTS "namespace" varchar(255);`,
  
  // From migration_0001 - Create indexes (OLD version without namespace)
  `CREATE INDEX IF NOT EXISTS "idx_events_thread_status" ON "events" ("threadId", "status");`,
  `CREATE INDEX IF NOT EXISTS "idx_events_pending_order"
    ON "events" (
      "threadId",
      (COALESCE("priority", 0)) DESC,
      "createdAt" ASC,
      "id" ASC
    )
    WHERE "status" = 'pending';`,
  `CREATE INDEX IF NOT EXISTS "idx_events_status_expires_at" ON "events" ("status", "expiresAt");`,
  
  // From migration_0005 - DO block for namespace
  `DO $$
  BEGIN
    -- Add namespace column if not exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns 
      WHERE table_name = 'events' AND column_name = 'namespace'
    ) THEN
      ALTER TABLE "events" ADD COLUMN "namespace" VARCHAR(255);
    END IF;

    -- Create index for namespace queries
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_namespace'
    ) THEN
      CREATE INDEX "idx_events_namespace" ON "events" ("namespace");
    END IF;

    -- Create composite index for namespace + status queries
    IF NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE indexname = 'idx_events_namespace_status'
    ) THEN
      CREATE INDEX "idx_events_namespace_status" ON "events" ("namespace", "status");
    END IF;

    -- Update pending events index to include namespace
    DROP INDEX IF EXISTS "idx_events_pending_order";
    CREATE INDEX "idx_events_pending_order"
      ON "events" (
        "threadId",
        "namespace",
        (COALESCE("priority", 0)) DESC,
        "createdAt" ASC,
        "id" ASC
      )
      WHERE "status" = 'pending';
  END $$;`
];

for (let i = 0; i < migrations.length; i++) {
  const sql = migrations[i];
  const preview = sql.substring(0, 60).replace(/\n/g, ' ');
  try {
    await client.query(sql);
    console.log(`✅ [${i + 1}] ${preview}...`);
  } catch (e) {
    console.log(`❌ [${i + 1}] ${preview}...`);
    console.log(`   Error: ${e.message}`);
  }
}

// Verify final state
console.log("\n=== After migration ===");
const afterCols = await client.query(`
  SELECT column_name FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'events';
`);
console.log("Columns:", afterCols.rows.map(r => r.column_name));

await client.end();

