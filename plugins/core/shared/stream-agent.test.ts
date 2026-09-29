import { assertEquals } from "@std/assert";
import { coreLlmStreamMetadata, coreStreamAgent } from "./workflow-metadata.ts";

Deno.test("coreStreamAgent reads the Agent from Core stream metadata", () => {
  const metadata = coreLlmStreamMetadata({ id: "critic", name: "Critic" });
  assertEquals(coreStreamAgent({ metadata }), { id: "critic", name: "Critic" });
});

Deno.test("coreStreamAgent reads the Agent answering an ask", () => {
  const metadata = coreLlmStreamMetadata(
    { id: "critic", name: "Critic" },
    {
      askId: "ask-1",
      phase: "answer",
      questionMessageId: "message-1",
      askingAgentId: "planner",
      askingAgentName: "Planner",
      askedAgentId: "critic",
      askedAgentName: "Critic",
    } as Parameters<typeof coreLlmStreamMetadata>[1],
  );
  assertEquals(coreStreamAgent({ metadata }), { id: "critic", name: "Critic" });
});

Deno.test("coreStreamAgent ignores streams Core's agents did not produce", () => {
  assertEquals(coreStreamAgent({}), undefined);
  assertEquals(coreStreamAgent({ metadata: {} }), undefined);
  assertEquals(
    coreStreamAgent({
      metadata: {
        copilotzCore: { schema: "other", agent: { id: "a", name: "A" } },
      },
    }),
    undefined,
  );
  assertEquals(
    coreStreamAgent({
      metadata: {
        copilotzCore: {
          schema: "copilotz.core.llm-stream.v1",
          agent: { id: "a" },
        },
      },
    }),
    undefined,
  );
});
