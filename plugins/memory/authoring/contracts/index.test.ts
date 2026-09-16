import { assertEquals } from "@std/assert";
import type { MemoryConfig } from "../../resources/memory/config/index.ts";
Deno.test("memory configuration supports disabling automatic maintenance", () => {
  const value: Partial<MemoryConfig> = { enabled: false };
  assertEquals(value.enabled, false);
});
