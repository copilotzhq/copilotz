import { assertEquals } from "@std/assert";
import { whatsappChannelPlugin } from "./index.ts";

Deno.test("WhatsApp Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = whatsappChannelPlugin;
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "whatsapp",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "whatsapp",
  ]);
});
