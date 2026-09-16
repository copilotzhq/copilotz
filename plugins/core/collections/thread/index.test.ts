import { assertEquals } from "@std/assert";
import { threadCollection } from "./index.ts";
Deno.test("Thread Collection owns its name", () =>
  assertEquals(threadCollection.name, "thread"));
