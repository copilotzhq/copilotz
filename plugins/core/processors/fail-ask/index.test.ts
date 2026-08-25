import { assertEquals } from "@std/assert";
import { failAskProcessor } from "./index.ts";
Deno.test("Fail Ask owns its identity", () =>
  assertEquals(failAskProcessor.id, "copilotz.core.fail-agent-ask"));
