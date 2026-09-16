import { assertEquals } from "@std/assert";
import { zendeskChannelPlugin } from "./index.ts";

Deno.test("Zendesk Channel plugin aligns Resource and Adapter aliases", () => {
  const plugin = zendeskChannelPlugin;
  assertEquals(Object.keys(plugin.resources.channels ?? {}), [
    "zendesk",
  ]);
  assertEquals(Object.keys(plugin.adapters.channels ?? {}), [
    "zendesk",
  ]);
});
