import { assertEquals } from "@std/assert";
import { createThreadAction } from "./index.ts";
Deno.test("create-thread Action owns its identity", () =>
  assertEquals(createThreadAction.id, "copilotz.core.thread.create"));
