import { assertEquals } from "@std/assert";
import { telegramChannelPlugin } from "./index.ts";

Deno.test("Telegram Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = telegramChannelPlugin;
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "telegram",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "telegram",
  ]);
});
