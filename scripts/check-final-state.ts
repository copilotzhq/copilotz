import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

console.log("=== Final Database State ===\n");

// Check events columns
console.log("Events columns:");
const eventsResult = await client.query(`
  SELECT column_name, data_type FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'events'
  ORDER BY ordinal_position;
`);
eventsResult.rows.forEach(r => console.log(`  - ${r.column_name}: ${r.data_type}`));

// Check nodes.id type
console.log("\nNodes.id type:");
const nodesResult = await client.query(`
  SELECT column_name, data_type FROM information_schema.columns 
  WHERE table_schema = 'public' AND table_name = 'nodes' AND column_name = 'id';
`);
console.log(`  - ${nodesResult.rows[0]?.data_type || 'NOT FOUND'}`);

// Check if namespace column exists in events
const hasNamespace = eventsResult.rows.some(r => r.column_name === 'namespace');
console.log(`\n✅ events.namespace exists: ${hasNamespace}`);

// Check if nodes.id is TEXT
const nodesIdIsText = nodesResult.rows[0]?.data_type === 'text';
console.log(`✅ nodes.id is TEXT: ${nodesIdIsText}`);

await client.end();

