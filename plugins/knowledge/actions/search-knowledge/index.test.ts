import { assertEquals } from "@std/assert";
import { SEARCH_KNOWLEDGE_ACTION_ID } from "./index.ts";

Deno.test("search-knowledge exposes its stable Action ID", () => {
  assertEquals(
    SEARCH_KNOWLEDGE_ACTION_ID,
    "copilotz.knowledge.searchDocuments",
  );
});
