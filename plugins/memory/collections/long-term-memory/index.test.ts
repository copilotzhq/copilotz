import { assertEquals } from "@std/assert";
import { longTermMemoryCollection } from "./index.ts";
Deno.test("checkpoint collection is named", () =>
  assertEquals(longTermMemoryCollection.name, "long_term_memory"));
