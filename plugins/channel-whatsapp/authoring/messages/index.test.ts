import { assertEquals } from "@std/assert";
import { splitWhatsAppText } from "./index.ts";

Deno.test("WhatsApp message authoring splits long text", () => {
  assertEquals(splitWhatsAppText("short"), ["short"]);
});
