import { assertEquals } from "@std/assert";
import { knowledgeChunkCollection } from "./index.ts";

Deno.test("chunk collection keeps its public name", () => {
  assertEquals(knowledgeChunkCollection.name, "chunk");
});
