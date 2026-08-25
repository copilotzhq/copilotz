import { assertEquals } from "@std/assert";
import { createDefaultKnowledgeTextExtractor } from "./index.ts";

Deno.test("default source extractor normalizes HTML", async () => {
  const extract = createDefaultKnowledgeTextExtractor();
  assertEquals(
    await extract({
      bytes: new TextEncoder().encode("<p>Hello</p>"),
      mediaType: "text/html",
      signal: new AbortController().signal,
    }),
    "Hello",
  );
});
