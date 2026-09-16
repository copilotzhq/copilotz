import { assertEquals } from "@std/assert";
import { whatsappChannelResource } from "./index.ts";

Deno.test("WhatsApp Channel Resource is data-only external policy", () => {
  assertEquals(whatsappChannelResource.egress, "external");
});
