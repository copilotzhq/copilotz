import { assertEquals } from "@std/assert";
import { webChannelPlugin } from "./index.ts";

Deno.test("Web Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = webChannelPlugin;
  assertEquals(Object.keys(plugin.resources.channels ?? {}), ["web"]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), ["web"]);
});
