import { assert, assertStringIncludes } from "@std/assert";

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

Deno.test("contextGenerator places stable local instructions before volatile thread context", () => {
  const agent: Agent = {
    id: "assistant",
    name: "Assistant",
    role: "assistant",
    instructions: "Help the user.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const thread = {
    id: "thread-1",
    name: "Customer-specific thread name",
    participants: ["User", "assistant"],
    status: "active",
    mode: "multi-agent",
    metadata: {
      public: {
        userContext: { accountId: "acct-dynamic" },
      },
    },
  } as Thread;

  const generated = contextGenerator(
    agent,
    thread,
    [agent],
    [agent],
    { preference: "dynamic" },
    undefined,
    [{ name: "stable-skill", description: "Stable skill.", tags: [] }],
    {
      path: "/app/AGENTS.md",
      cwd: "/app",
      fileName: "AGENTS.md",
      mtimeMs: 1,
      content: "Stable AGENTS content.",
    },
  );

  const localIndex = generated.systemPrompt.indexOf(
    "## LOCAL AGENTS INSTRUCTIONS",
  );
  const skillsIndex = generated.systemPrompt.indexOf("## AVAILABLE SKILLS");
  const identityIndex = generated.systemPrompt.indexOf("## IDENTITY");
  const threadIndex = generated.systemPrompt.indexOf(
    "## CONVERSATION CONTEXT",
  );
  const metadataIndex = generated.systemPrompt.indexOf("## THREAD METADATA");
  const userMetadataIndex = generated.systemPrompt.indexOf("## USER METADATA");

  assert(localIndex >= 0);
  assert(skillsIndex > localIndex);
  assert(identityIndex > skillsIndex);
  assert(threadIndex > identityIndex);
  assert(metadataIndex > threadIndex);
  assert(userMetadataIndex > metadataIndex);
});

Deno.test("contextGenerator advertises reserved controls only when multi-agent routing is enabled", () => {
  const lead: Agent = {
    id: "lead",
    name: "Lead",
    role: "assistant",
    instructions: "Coordinate the team.",
  };
  const reviewer: Agent = {
    id: "reviewer",
    name: "Reviewer",
    role: "critic",
    instructions: "Review work.",
  };
  const thread = {
    id: "thread-1",
    name: "Team",
    participants: ["user-1", "lead", "reviewer"],
  } as Thread;

  const disabled = contextGenerator(
    lead,
    thread,
    [lead, reviewer],
    [lead, reviewer],
  );
  assert(!disabled.systemPrompt.includes("ask_in_thread"));
  assert(!disabled.systemPrompt.includes("handoff_in_thread"));
  assert(!disabled.systemPrompt.includes("<route_to>"));
  assert(!disabled.systemPrompt.includes("<ask_to>"));

  const enabled = contextGenerator(
    lead,
    thread,
    [lead, reviewer],
    [lead, reviewer],
    undefined,
    undefined,
    undefined,
    undefined,
    { ask: true, handoff: true },
  );
  assertStringIncludes(enabled.systemPrompt, "ask_in_thread");
  assertStringIncludes(enabled.systemPrompt, "handoff_in_thread");
  assertStringIncludes(enabled.systemPrompt, "target and message");
  assertStringIncludes(
    enabled.systemPrompt,
    "Visible text before a routing control is public",
  );
  assertStringIncludes(
    enabled.systemPrompt,
    "never combine it with another tool call",
  );
  assert(!enabled.systemPrompt.includes("<route_to>"));
  assert(!enabled.systemPrompt.includes("<ask_to>"));

  const handoffOnly = contextGenerator(
    lead,
    thread,
    [lead, reviewer],
    [lead, reviewer],
    undefined,
    undefined,
    undefined,
    undefined,
    { handoff: true },
  );
  assert(!handoffOnly.systemPrompt.includes("ask_in_thread"));
  assertStringIncludes(handoffOnly.systemPrompt, "handoff_in_thread");
});
