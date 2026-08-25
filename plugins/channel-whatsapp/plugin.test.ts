import { assertEquals } from "@std/assert";
import { createWhatsAppChannelPlugin } from "./index.ts";

Deno.test("WhatsApp Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = createWhatsAppChannelPlugin({
    channelId: "whatsapp-custom",
    config: { accessToken: "secret", phoneId: "phone" },
  });
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "whatsapp-custom",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "whatsapp-custom",
  ]);
});
