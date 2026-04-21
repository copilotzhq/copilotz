import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { Agent, NewMessage } from "@/types/index.ts";
import { historyGenerator } from "./history-generator.ts";

Deno.test("historyGenerator uses sender display names instead of graph ids in prefixes", () => {
  const currentAgent: Agent = {
    id: "generalist-genius",
    name: "generalist-genius",
    role: "assistant",
    instructions: "Coordinate work.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const chatHistory: NewMessage[] = [
    {
      id: "m-1",
      threadId: "thread-1",
      senderId: "01KPRA3BP9DJKMQ3PP12WPCCPW",
      senderType: "agent",
      content: "I am right here!",
      metadata: {
        senderDisplayName: "generalist-genius",
        senderExternalId: "generalist-genius",
        senderParticipantId: "01KPRA3BP9DJKMQ3PP12WPCCPW",
      },
    },
    {
      id: "m-2",
      threadId: "thread-1",
      senderId: "01KPRA3BP3R32CS5DV7X62ZCT9",
      senderType: "agent",
      content: "Good news — they just posted!",
      metadata: {
        senderDisplayName: "reviewer",
        senderExternalId: "reviewer",
        senderParticipantId: "01KPRA3BP3R32CS5DV7X62ZCT9",
      },
    },
  ];

  const generated = historyGenerator(chatHistory, currentAgent, {
    includeTargetContext: true,
  });

  assertEquals(generated[0]?.role, "assistant");
  assertEquals(generated[0]?.content, "I am right here!");
  assertEquals(
    generated[1]?.content,
    "[reviewer]: Good news — they just posted!",
  );
});
