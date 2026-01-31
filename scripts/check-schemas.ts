import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// Check ALL tables named "events" in ALL schemas
console.log("=== All tables named 'events' across ALL schemas ===");
const eventsResult = await client.query(`
  SELECT table_schema, table_name
  FROM information_schema.tables 
  WHERE table_name = 'events'
  ORDER BY table_schema;
`);
console.log(eventsResult.rows);

// Check if namespace column exists in any events table
console.log("\n=== 'namespace' column in any 'events' table ===");
const namespaceResult = await client.query(`
  SELECT table_schema, table_name, column_name
  FROM information_schema.columns 
  WHERE table_name = 'events' AND column_name = 'namespace'
  ORDER BY table_schema;
`);
console.log(namespaceResult.rows);

// Check current schema
console.log("\n=== Current schema ===");
const schemaResult = await client.query(`SELECT current_schema();`);
console.log(schemaResult.rows);

await client.end();

