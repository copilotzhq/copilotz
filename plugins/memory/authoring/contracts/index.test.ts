import { assertEquals } from "@std/assert";
import type { CreateLongTermMemoryPluginOptions } from "./index.ts";
Deno.test("memory contracts accept disabled configuration", () => {
  const value: CreateLongTermMemoryPluginOptions = { enabled: false };
  assertEquals(value.enabled, false);
});
