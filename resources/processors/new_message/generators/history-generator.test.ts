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

Deno.test("historyGenerator truncates large tool outputs when maxToolResultChars is set", () => {
  const currentAgent: Agent = {
    id: "agent-1",
    name: "agent-1",
    role: "assistant",
    instructions: "Do work.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const huge = "y".repeat(500);
  const chatHistory: NewMessage[] = [
    {
      id: "m-tool",
      threadId: "t-1",
      senderId: "agent-1",
      senderType: "tool",
      content: "",
      metadata: {
        toolResultQueueEventId: "queue-evt-1",
        toolCalls: [{
          id: "c1",
          tool: { id: "http_request" },
          args: "{}",
          output: { body: huge },
        }],
      },
    },
  ];

  const generated = historyGenerator(chatHistory, currentAgent, {
    includeTargetContext: false,
    maxToolResultChars: 120,
  });

  assertEquals(generated.length, 1);
  assertEquals(generated[0]?.role, "tool");
  const tc = generated[0]?.toolCalls?.[0];
  assertEquals(typeof tc?.output, "object");
  const out = tc?.output as Record<string, unknown>;
  assertEquals(out._copilotz_history_truncated, true);
  assertEquals(out.toolResultQueueEventId, "queue-evt-1");
  assertEquals(typeof out.preview, "string");
  assertEquals((out.preview as string).length < huge.length, true);
});

Deno.test("historyGenerator defaults tool output cap to 10_000 chars when maxToolResultChars omitted", () => {
  const currentAgent: Agent = {
    id: "agent-1",
    name: "agent-1",
    role: "assistant",
    instructions: "Do work.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const huge = "z".repeat(15_000);
  const chatHistory: NewMessage[] = [
    {
      id: "m-tool",
      threadId: "t-1",
      senderId: "agent-1",
      senderType: "tool",
      content: "",
      metadata: {
        toolCalls: [{
          id: "c1",
          tool: { id: "t" },
          args: "{}",
          output: { body: huge },
        }],
      },
    },
  ];

  const generated = historyGenerator(chatHistory, currentAgent, {
    includeTargetContext: false,
  });
  const out = generated[0]?.toolCalls?.[0]?.output as Record<string, unknown>;
  assertEquals(out._copilotz_history_truncated, true);
  assertEquals(
    (out.preview as string).length < huge.length,
    true,
  );
});
