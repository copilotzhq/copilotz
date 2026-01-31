import pg from "npm:pg";

const DATABASE_URL = "postgresql://postgres:nqaKkbHIs94CMUrG@db.tbqlpqhctuzjrxruxfii.supabase.co:5432/postgres";

const client = new pg.Client({ connectionString: DATABASE_URL });
await client.connect();

// Check events table columns
const result = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns 
  WHERE table_name = 'events'
  ORDER BY ordinal_position;
`);

console.log("Events table columns:");
console.log(result.rows);

await client.end();

