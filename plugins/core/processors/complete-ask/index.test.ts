import { assertEquals } from "@std/assert";
import { completeAskProcessor } from "./index.ts";
Deno.test("Complete Ask owns its identity", () =>
  assertEquals(completeAskProcessor.id, "copilotz.core.complete-agent-ask"));
