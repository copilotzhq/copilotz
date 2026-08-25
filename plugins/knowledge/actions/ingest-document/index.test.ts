import { assertEquals } from "@std/assert";
import { ingestKnowledgeDocumentAction } from "./index.ts";

Deno.test("ingest-document owns its stable Action ID", () => {
  assertEquals(
    ingestKnowledgeDocumentAction.id,
    "copilotz.knowledge.ingestDocument",
  );
});
