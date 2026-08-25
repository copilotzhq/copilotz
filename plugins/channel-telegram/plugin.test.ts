import { assertEquals } from "@std/assert";
import { createTelegramChannelPlugin } from "./index.ts";

Deno.test("Telegram Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = createTelegramChannelPlugin({
    channelId: "telegram-custom",
    config: { botToken: "secret" },
  });
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "telegram-custom",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "telegram-custom",
  ]);
});
