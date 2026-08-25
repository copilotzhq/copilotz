import { assertEquals } from "@std/assert";
import { messageInputProcessor } from "./index.ts";
Deno.test("Message input Processor owns its identity", () =>
  assertEquals(messageInputProcessor.id, "copilotz.core.message-input"));
