/**
 * Debug script to log all migrations being generated and sent to Ominipg.
 * 
 * Run with: deno run -A scripts/debug-migrations.ts
 */

import { generateMigrations } from "../database/migrations/migration_0001.ts";
import { generateRagMigrations } from "../database/migrations/migration_0002_rag.ts";
import { generateKnowledgeGraphMigrations } from "../database/migrations/migration_0003_knowledge_graph.ts";
import { generateUlidSupportMigrations } from "../database/migrations/migration_0004_ulid_support.ts";
import { generateNamespaceEventsMigrations } from "../database/migrations/migration_0005_namespace_events.ts";
import { splitSQLStatements } from "../database/migrations/utils.ts";

console.log("=".repeat(80));
console.log("COPILOTZ MIGRATION DEBUG");
console.log("=".repeat(80));

// Generate all migrations (same order as database/index.ts)
const migration1 = generateMigrations();
const migration2 = generateRagMigrations();
const migration3 = generateKnowledgeGraphMigrations();
const migration4 = generateUlidSupportMigrations();
const migration5 = generateNamespaceEventsMigrations();

const allMigrations = migration1 + "\n" + migration2 + "\n" + migration3 + "\n" + migration4 + "\n" + migration5;

// Split into statements (exactly what Ominipg receives)
const statements = splitSQLStatements(allMigrations);

statements.forEach((stmt, index) => {
    console.log(stmt);
    console.log("\n---\n");
});
