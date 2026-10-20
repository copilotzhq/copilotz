/** Proves the exact pre-conversion factory refuses an in-progress offline marker. */
const [checkout, schema] = Deno.args;
if (!checkout || !schema) throw new Error("Expected old checkout and schema.");
const revision = await new Deno.Command("git", {
  args: ["-C", checkout, "rev-parse", "HEAD"],
  stdout: "piped",
}).output();
if (
  new TextDecoder().decode(revision.stdout).trim() !==
    "8736b9c8b86f09b8febf3e2510f904ebfd2be28c"
) throw new Error("Unexpected old checkout revision.");
const { createCopilotz } = await import(
  new URL("create-copilotz.ts", `file://${checkout}/`).href
);
let rejected = false;
try {
  const app = await createCopilotz({
    database: { url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") },
    databaseSchema: schema,
    namespace: "archive",
  });
  await app.close();
} catch (error) {
  if ((error as { code?: string }).code !== "copilotz_schema_incompatible") {
    throw error;
  }
  rejected = true;
}
if (!rejected) throw new Error("Old runtime admitted the interrupted upgrade.");
console.log("Exact old runtime rejected the in-progress schema marker.");
