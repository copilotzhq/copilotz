import { assertEquals } from "@std/assert";
import { discordChannelPlugin } from "./index.ts";

Deno.test("Discord Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = discordChannelPlugin;
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "discord",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "discord",
  ]);
});
