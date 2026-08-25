import { assertEquals } from "@std/assert";
import { memorySpaceCollection } from "./index.ts";
Deno.test("memory space collection is named", () =>
  assertEquals(memorySpaceCollection.name, "memory_space"));
