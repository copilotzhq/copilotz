import { assertEquals } from "@std/assert";
import { deleteKnowledgeDocumentAction } from "./index.ts";

Deno.test("delete-document owns its stable Action ID", () => {
  assertEquals(
    deleteKnowledgeDocumentAction.id,
    "copilotz.knowledge.deleteDocument",
  );
});
