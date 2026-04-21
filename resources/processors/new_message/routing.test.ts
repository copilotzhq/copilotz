import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { resolveThreadParticipantTarget } from "./index.ts";
import type { Agent, Thread } from "@/types/index.ts";

Deno.test("resolveThreadParticipantTarget preserves a user return target for legacy threads with one human participant", () => {
  const availableAgents: Agent[] = [
    {
      id: "reviewer",
      name: "reviewer",
      role: "assistant",
      instructions: "Review work.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    },
    {
      id: "generalist-genius",
      name: "generalist-genius",
      role: "assistant",
      instructions: "Coordinate work.",
      llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    },
  ];

  const thread = {
    id: "thread-1",
    name: "Main Thread",
    participants: ["reviewer", "generalist-genius"],
    metadata: {
      system: {
        runtime: {
          userExternalId: "User",
        },
      },
    },
  } as unknown as Thread;

  assertEquals(
    resolveThreadParticipantTarget("User", thread, availableAgents),
    "User",
  );
});
