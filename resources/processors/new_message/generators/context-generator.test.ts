import {
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { Agent, Thread } from "@/types/index.ts";
import { contextGenerator } from "./context-generator.ts";

Deno.test("contextGenerator resolves agent participants by id as well as name", () => {
  const currentAgent: Agent = {
    id: "timekeeper",
    name: "TimeKeeper",
    role: "assistant",
    instructions: "Handle time requests.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const thread = {
    id: "thread-1",
    name: "Main Thread",
    participants: ["User", "timekeeper", "reviewer"],
    metadata: null,
  } as Thread;

  const reviewer: Agent = {
    id: "reviewer",
    name: "Reviewer",
    role: "critic",
    instructions: "Review responses.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const generated = contextGenerator(
    currentAgent,
    thread,
    [currentAgent, reviewer],
    [currentAgent, reviewer],
  );

  assertStringIncludes(generated.systemPrompt, "- **timekeeper** (you)");
  assertStringIncludes(generated.systemPrompt, "Role: assistant");
  assert(!generated.systemPrompt.includes("- **timekeeper**\n  Role: User"));
});
