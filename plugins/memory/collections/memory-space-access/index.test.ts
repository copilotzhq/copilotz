import { assertEquals } from "@std/assert";
import { memorySpaceAccessCollection } from "./index.ts";
Deno.test("memory access collection is named", () =>
  assertEquals(memorySpaceAccessCollection.name, "memory_space_access"));
