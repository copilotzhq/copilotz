import { assertEquals } from "@std/assert";
import { projectAgentFailureProcessor } from "./index.ts";

Deno.test("projectAgentFailureProcessor listens only for terminal LLM failures", () => {
  assertEquals(
    projectAgentFailureProcessor.id,
    "copilotz.core.project-agent-failure",
  );
  assertEquals(
    projectAgentFailureProcessor.on.map((subscription) =>
      subscription.eventType
    ),
    ["llm.call.failed", "llm.call.cancelled"],
  );
});
