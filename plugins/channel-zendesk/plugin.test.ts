import { assertEquals } from "@std/assert";
import { createZendeskChannelPlugin } from "./index.ts";

Deno.test("Zendesk Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = createZendeskChannelPlugin({
    channelId: "zendesk-custom",
    config: { appId: "app", apiKey: "key", apiSecret: "secret" },
  });
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "zendesk-custom",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "zendesk-custom",
  ]);
});
