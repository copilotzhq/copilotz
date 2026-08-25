import { assertEquals } from "@std/assert";
import { createDiscordChannelPlugin } from "./index.ts";

Deno.test("Discord Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = createDiscordChannelPlugin({
    channelId: "discord-custom",
    config: {
      applicationId: "application",
      publicKey: "public",
      botToken: "secret",
    },
  });
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "discord-custom",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "discord-custom",
  ]);
});
