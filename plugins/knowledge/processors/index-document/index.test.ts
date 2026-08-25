import { assertEquals } from "@std/assert";
import { indexKnowledgeDocumentProcessor } from "./index.ts";

Deno.test("index processor keeps its stable ID", () => {
  assertEquals(
    indexKnowledgeDocumentProcessor.id,
    "copilotz.knowledge.index-document",
  );
});
