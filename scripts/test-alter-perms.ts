import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// Drop and recreate events without namespace to test
console.log("Recreating events table without namespace...");
await client.query(`DROP TABLE IF EXISTS "events" CASCADE;`);
await client.query(`
  CREATE TABLE "events" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "threadId" varchar(255) NOT NULL,
    "eventType" varchar(64) NOT NULL,
    "payload" jsonb NOT NULL,
    "status" varchar DEFAULT 'pending' NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );
`);

// Test if ADD COLUMN IF NOT EXISTS works
console.log("\nTesting ADD COLUMN IF NOT EXISTS...");
try {
  await client.query(`ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "namespace" varchar(255);`);
  console.log("✅ ADD COLUMN IF NOT EXISTS works!");
} catch (e) {
  console.log("❌ ADD COLUMN IF NOT EXISTS failed:", e.message);
}

// Verify
const cols = await client.query(`
  SELECT column_name FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'events';
`);
console.log("Columns:", cols.rows.map(r => r.column_name));

// Now test the full DO block from migration_0005
console.log("\n\nNow testing the FULL DO block migration...");
await client.query(`DROP TABLE IF EXISTS "events" CASCADE;`);
await client.query(`
  CREATE TABLE "events" (
    "id" varchar(255) PRIMARY KEY NOT NULL,
    "threadId" varchar(255) NOT NULL,
    "eventType" varchar(64) NOT NULL,
    "payload" jsonb NOT NULL,
    "status" varchar DEFAULT 'pending' NOT NULL,
    "createdAt" timestamp DEFAULT now() NOT NULL,
    "updatedAt" timestamp DEFAULT now() NOT NULL
  );
`);

// Create the old index (without namespace)
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

// Execute the DO block
try {
  await client.query(`
    DO $$
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
    END $$;
  `);
  console.log("✅ DO block executed successfully!");
} catch (e) {
  console.log("❌ DO block failed:", e.message);
}

// Verify final state
const finalCols = await client.query(`
  SELECT column_name FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'events';
`);
console.log("Final columns:", finalCols.rows.map(r => r.column_name));

await client.end();

