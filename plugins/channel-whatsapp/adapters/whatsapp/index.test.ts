import { assertThrows } from "@std/assert";
import { createWhatsAppChannelAdapter } from "./index.ts";

Deno.test("WhatsApp Channel Adapter requires provider config", () => {
  assertThrows(
    () => createWhatsAppChannelAdapter(undefined as never),
    TypeError,
    "requires config",
  );
});
