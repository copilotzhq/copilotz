import { assertEquals } from "@std/assert";
import { createWebChannelPlugin } from "./index.ts";

Deno.test("Web Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = createWebChannelPlugin({ channelId: "web-custom" });
  assertEquals(Object.keys(plugin.resources.channels ?? {}), ["web-custom"]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), ["web-custom"]);
});
