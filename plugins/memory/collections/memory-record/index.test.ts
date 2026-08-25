import { assertEquals } from "@std/assert";
import { memoryRecordCollection } from "./index.ts";
Deno.test("record collection is named", () =>
  assertEquals(memoryRecordCollection.name, "memory_record"));
