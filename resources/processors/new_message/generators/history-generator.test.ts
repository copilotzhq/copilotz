import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { Agent, NewMessage } from "@/types/index.ts";
import { formatMessages } from "@/runtime/llm/utils.ts";
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

Deno.test("historyGenerator includes only current agent reasoning by default", () => {
  const currentAgent: Agent = {
    id: "agent-1",
    name: "agent-1",
    role: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const generated = historyGenerator([
    {
      threadId: "t-1",
      senderId: "agent-1",
      senderType: "agent",
      content: "I found the answer.",
      reasoning: "Need to summarize the result.",
    },
    {
      threadId: "t-1",
      senderId: "agent-2",
      senderType: "agent",
      content: "Peer answer.",
      reasoning: "Peer private reasoning.",
      metadata: { senderDisplayName: "reviewer" },
    },
  ], currentAgent);

  assertEquals(
    generated[0]?.content,
    "<think>\nNeed to summarize the result.\n</think>\n\nI found the answer.",
  );
  assertEquals(generated[1]?.content, "[reviewer]: Peer answer.");
});

Deno.test("historyGenerator can disable reasoning history", () => {
  const currentAgent: Agent = {
    id: "agent-1",
    name: "agent-1",
    role: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const generated = historyGenerator(
    [
      {
        threadId: "t-1",
        senderId: "agent-1",
        senderType: "agent",
        content: "Visible answer.",
        reasoning: "Hidden reasoning.",
      },
    ],
    currentAgent,
    {
      reasoningHistory: { include: "none" },
    },
  );

  assertEquals(generated[0]?.content, "Visible answer.");
});

Deno.test("historyGenerator can include all agent reasoning with a cap", () => {
  const currentAgent: Agent = {
    id: "agent-1",
    name: "agent-1",
    role: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const generated = historyGenerator(
    [
      {
        threadId: "t-1",
        senderId: "agent-2",
        senderType: "agent",
        content: "Peer answer.",
        reasoning: "x".repeat(80),
        metadata: { senderDisplayName: "reviewer" },
      },
    ],
    currentAgent,
    {
      reasoningHistory: { include: "all", maxChars: 60 },
    },
  );

  assertEquals(
    generated[0]?.content,
    "<think>\nxxxxxxxxxxxxxxxxxxxx\n[reasoning truncated: 20 chars omitted]\n</think>\n\n[reviewer]: Peer answer.",
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
      content: JSON.stringify({ secret: "raw output" }),
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

Deno.test("historyGenerator renders peer public_status tool result as attributed user tags", () => {
  const currentAgent: Agent = {
    id: "reviewer",
    name: "reviewer",
    role: "assistant",
    instructions: "Review work.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const chatHistory: NewMessage[] = [
    {
      id: "m-tool",
      threadId: "t-1",
      senderId: "researcher",
      senderType: "tool",
      content: "",
      metadata: {
        toolCalls: [{
          id: "c1",
          tool: { id: "search_web" },
          args: JSON.stringify({ query: "private query" }),
          output: { secret: "raw output" },
          status: "completed",
          visibility: "public_status",
        }],
      },
    },
  ];

  const generated = historyGenerator(chatHistory, currentAgent, {
    includeTargetContext: false,
  });

  assertEquals(generated.length, 1);
  assertEquals(generated[0]?.role, "user");
  assertEquals(generated[0]?.toolCalls, undefined);
  assertEquals(generated[0]?.metadata?.toolCalls, undefined);
  assertEquals(
    generated[0]?.content,
    [
      "[researcher]:",
      "<tool_results>",
      JSON.stringify({
        name: "search_web",
        status: "completed",
        output: { _copilotz_omitted: true, reason: "public_status" },
        tool_call_id: "c1",
      }),
      "</tool_results>",
    ].join("\n"),
  );

  const formatted = formatMessages({ messages: generated });
  assertEquals(formatted.length, 1);
  assertEquals(formatted[0]?.role, "user");
});

Deno.test("historyGenerator keeps full default tool result for requesting agent", () => {
  const currentAgent: Agent = {
    id: "researcher",
    name: "researcher",
    role: "assistant",
    instructions: "Research.",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const chatHistory: NewMessage[] = [
    {
      id: "m-tool",
      threadId: "t-1",
      senderId: "researcher",
      senderType: "tool",
      content: "",
      metadata: {
        toolCalls: [{
          id: "c1",
          tool: { id: "search_web" },
          args: JSON.stringify({ query: "private query" }),
          output: { secret: "raw output" },
          status: "completed",
        }],
      },
    },
  ];

  const generated = historyGenerator(chatHistory, currentAgent, {
    includeTargetContext: false,
  });

  assertEquals(generated.length, 1);
  assertEquals(generated[0]?.toolCalls?.[0], {
    id: "c1",
    tool: { id: "search_web" },
    args: JSON.stringify({ query: "private query" }),
    output: { secret: "raw output" },
    status: "completed",
  });
});

Deno.test("historyGenerator renders peer public tool calls and results fully as user transcript", () => {
  const currentAgent: Agent = {
    id: "north",
    name: "North",
    role: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const generated = historyGenerator(
    [
      {
        id: "m-call",
        threadId: "t-1",
        senderId: "east",
        senderType: "agent",
        content: "<span></span>",
        toolCalls: [{
          id: "c1",
          tool: { id: "sandbox_session" },
          args: JSON.stringify({ actions: [{ action: "exec", cmd: "ls" }] }),
        }] as never,
        metadata: { senderDisplayName: "East" },
      },
      {
        id: "m-tool",
        threadId: "t-1",
        senderId: "east",
        senderType: "tool",
        content: "",
        metadata: {
          senderDisplayName: "East",
          toolCalls: [{
            id: "c1",
            tool: { id: "sandbox_session" },
            args: JSON.stringify({ actions: [{ action: "exec", cmd: "ls" }] }),
            output: { success: true },
            status: "completed",
            visibility: "public",
          }],
        },
      },
    ],
    currentAgent,
    { includeTargetContext: false },
  );

  assertEquals(generated.length, 2);
  assertEquals(generated[0]?.role, "user");
  assertEquals(
    generated[0]?.content,
    [
      "[East]:",
      "<tool_calls>",
      JSON.stringify({
        name: "sandbox_session",
        status: "requested",
        arguments: { actions: [{ action: "exec", cmd: "ls" }] },
        tool_call_id: "c1",
      }),
      "</tool_calls>",
    ].join("\n"),
  );
  assertEquals(generated[1]?.role, "user");
  assertEquals(
    generated[1]?.content,
    [
      "[East]:",
      "<tool_results>",
      JSON.stringify({
        name: "sandbox_session",
        status: "completed",
        output: { success: true },
        tool_call_id: "c1",
      }),
      "</tool_results>",
    ].join("\n"),
  );

  const formatted = formatMessages({ messages: generated });
  assertEquals(formatted.length, 1);
  assertEquals(formatted[0]?.role, "user");
  assertEquals(
    formatted[0]?.content,
    [
      "[East]:",
      "<tool_calls>",
      JSON.stringify({
        name: "sandbox_session",
        status: "requested",
        arguments: { actions: [{ action: "exec", cmd: "ls" }] },
        tool_call_id: "c1",
      }),
      "</tool_calls>",
      "",
      "[East]:",
      "<tool_results>",
      JSON.stringify({
        name: "sandbox_session",
        status: "completed",
        output: { success: true },
        tool_call_id: "c1",
      }),
      "</tool_results>",
    ].join("\n"),
  );
});

Deno.test("historyGenerator omits peer requester_only tool activity and empty placeholders", () => {
  const currentAgent: Agent = {
    id: "north",
    name: "North",
    role: "assistant",
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };

  const generated = historyGenerator(
    [
      {
        id: "m-call",
        threadId: "t-1",
        senderId: "east",
        senderType: "agent",
        content: "<span></span>",
        toolCalls: [{
          id: "c-private",
          tool: { id: "secret_tool" },
          args: JSON.stringify({ secret: true }),
        }] as never,
        metadata: { senderDisplayName: "East" },
      },
      {
        id: "m-tool",
        threadId: "t-1",
        senderId: "east",
        senderType: "tool",
        content: "",
        metadata: {
          senderDisplayName: "East",
          toolCalls: [{
            id: "c-private",
            tool: { id: "secret_tool" },
            args: JSON.stringify({ secret: true }),
            output: { secret: "raw" },
            status: "completed",
            visibility: "requester_only",
          }],
        },
      },
    ],
    currentAgent,
    { includeTargetContext: false },
  );

  assertEquals(generated, []);
});
