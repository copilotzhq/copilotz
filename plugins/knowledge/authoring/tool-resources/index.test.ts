import { assertEquals } from "@std/assert";
import { createKnowledgeActionResources } from "./index.ts";

Deno.test("Knowledge tool authoring uses stable default aliases", () => {
  const result = createKnowledgeActionResources({ provider: "fixture" });
  assertEquals(Object.keys(result.tools), [
    "ingest_document",
    "search_knowledge",
    "delete_document",
  ]);
});
