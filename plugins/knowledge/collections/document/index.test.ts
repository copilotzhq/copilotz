import { assertEquals } from "@std/assert";
import { knowledgeDocumentCollection } from "./index.ts";

Deno.test("document collection keeps its public name", () => {
  assertEquals(knowledgeDocumentCollection.name, "document");
});
