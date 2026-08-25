import { assertEquals } from "@std/assert";
import { createWhatsAppChannelResource } from "./index.ts";

Deno.test("WhatsApp Channel Resource is data-only external policy", () => {
  assertEquals(createWhatsAppChannelResource().egress, "external");
});
