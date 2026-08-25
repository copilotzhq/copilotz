import { assertEquals } from "@std/assert";
import { INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID } from "./index.ts";

Deno.test("index-document exposes its stable Action ID", () => {
  assertEquals(
    INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
    "copilotz.knowledge.indexDocument",
  );
});
