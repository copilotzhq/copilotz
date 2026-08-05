import { assertEquals } from "@std/assert";
import { runRuntimeSmoke } from "./runtime-smoke.ts";

Deno.test("runtime-neutral plugin, provider, asset, and stream smoke", async () => {
  assertEquals(await runRuntimeSmoke(), {
    plugin: "smoke.plugin",
    processor: "smoke.processor",
    bytes: [2, 3, 4],
  });
});
