/** Tests Knowledge-owned document chunking. @module */
import { assertEquals, assertGreater } from "@std/assert";
import { chunkText } from "./chunker.ts";

Deno.test("Knowledge chunking preserves order and bounded overlap", () => {
  const chunks = chunkText(
    "alpha beta gamma delta epsilon zeta eta theta iota kappa",
    { chunkSize: 4, chunkOverlap: 1 },
  );

  assertGreater(chunks.length, 1);
  assertEquals(
    chunks.map((chunk) => chunk.metadata.chunkIndex),
    chunks.map((_chunk, index) => index),
  );
  for (const chunk of chunks) {
    assertGreater(chunk.content.length, 0);
    assertGreater(chunk.metadata.tokenCount, 0);
  }
});
