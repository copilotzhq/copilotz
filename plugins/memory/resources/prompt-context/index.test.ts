import { assertEquals } from "@std/assert";
import { createMemoryContextResource } from "./index.ts";
Deno.test("memory context has stable id", () =>
  assertEquals(createMemoryContextResource(true).id, "copilotz.long_term"));
