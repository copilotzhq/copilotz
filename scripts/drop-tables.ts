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

console.log("All tables dropped!");
await client.end();

