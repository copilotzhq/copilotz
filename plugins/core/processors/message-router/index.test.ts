import { assertEquals } from "@std/assert";
import { messageRouterProcessor } from "./index.ts";
Deno.test("Message Router owns its identity", () =>
  assertEquals(messageRouterProcessor.id, "copilotz.core.message-to-llm-call"));
