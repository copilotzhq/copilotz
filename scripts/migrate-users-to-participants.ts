import { createDatabase } from "../index.ts";

/**
 * Migration script to convert legacy 'user' nodes to the unified 'participant' collection.
 * 
 * Run with:
 * DATABASE_URL=... deno run -A scripts/migrate-users-to-participants.ts
 */
async function migrate() {
  const db = await createDatabase();
  const { query } = db.ops;

  // Parse arguments
  const userArg = Deno.args.find(arg => arg.startsWith("--user="))?.split("=")[1];
  const filterClause = userArg ? ` AND "source_id" = '${userArg}'` : "";

  if (userArg) {
    console.log(`🚀 Starting Participant Migration for user: ${userArg}...`);
  } else {
    console.log("🚀 Starting Participant Migration for ALL users...");
  }

  // 1. Re-label 'user' nodes as 'participant'
  const typeResult = await query(`
    UPDATE "nodes" 
    SET "type" = 'participant' 
    WHERE "type" = 'user' ${filterClause}
  `);
  console.log(`- Updated type column for ${typeResult.rowCount ?? 0} nodes.`);

  // 2. Ensure 'participantType' exists in JSON
  const partTypeResult = await query(`
    UPDATE "nodes"
    SET "data" = "data" || jsonb_build_object(
      'participantType', 
      CASE WHEN "source_type" = 'agent' THEN 'agent' ELSE 'human' END
    )
    WHERE "type" = 'participant' 
    AND ("data"->>'participantType') IS NULL ${filterClause}
  `);
  console.log(`- Ensured participantType in JSON for ${partTypeResult.rowCount ?? 0} nodes.`);

  // 3. Ensure 'externalId' exists in JSON
  const extIdResult = await query(`
    UPDATE "nodes"
    SET "data" = "data" || jsonb_build_object('externalId', "source_id")
    WHERE "type" = 'participant' 
    AND ("data"->>'externalId') IS NULL ${filterClause}
  `);
  console.log(`- Ensured externalId in JSON for ${extIdResult.rowCount ?? 0} nodes.`);

  // 4. Identity Namespace Widening
  const nsResult = await query(`
    UPDATE "nodes"
    SET "namespace" = split_part("namespace", ':thread:', 1)
    WHERE "type" = 'participant' 
    AND "namespace" LIKE '%:thread:%' ${filterClause}
  `);
  console.log(`- Widened namespace for ${nsResult.rowCount ?? 0} nodes.`);

  console.log("\n✅ Migration complete.");
  console.log("👉 IMPORTANT: Restart your Copilotz instance to trigger new index creation.");
  
  await (db as any).shutdown?.();
  Deno.exit(0);
}

if (import.meta.main) {
  migrate().catch((err) => {
    console.error("❌ Migration failed:", err);
    Deno.exit(1);
  });
}
