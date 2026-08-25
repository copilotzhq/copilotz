import { assertEquals } from "@std/assert";
import { createSearchMemoryAction } from "./index.ts";
Deno.test("search action is named", () =>
  assertEquals(createSearchMemoryAction().id, "copilotz.memory.search"));
