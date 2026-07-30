import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Agent, Event, NewMessage } from "@/types/index.ts";
import type { ChatMessage } from "@/runtime/llm/types.ts";
import { buildTurnControlMessage, markLatestExternalRequest } from "./index.ts";

Deno.test("buildTurnControlMessage appends explicit active and return ownership", () => {
  const message = buildTurnControlMessage(
    { id: "west", name: "Lead", role: "assistant" } as Agent,
    {
      metadata: {
        targetQueue: ["user-1"],
      },
    } as unknown as Event,
    true,
  );

  assertEquals(message.role, "system");
  assertStringIncludes(String(message.content), "<turn_control>");
  assertStringIncludes(String(message.content), "active_agent: west");
  assertStringIncludes(String(message.content), "returns_to: user-1");
  assertStringIncludes(String(message.content), "call consult_agent");
  assertStringIncludes(
    String(message.content),
    "Calling a normal tool keeps you active",
  );
});

Deno.test("markLatestExternalRequest marks the latest initiating request but not tool results", () => {
  const history = [
    {
      id: "request-1",
      threadId: "thread-1",
      senderId: "user-1",
      senderType: "user",
    },
    {
      id: "agent-call",
      threadId: "thread-1",
      senderId: "east",
      senderType: "agent",
    },
    {
      id: "tool-result",
      threadId: "thread-1",
      senderId: "east",
      senderType: "tool",
    },
  ] satisfies NewMessage[];
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: "Call a tool.",
      metadata: { sourceMessageId: "request-1" },
    },
    {
      role: "assistant",
      content: "Calling.",
      metadata: { sourceMessageId: "agent-call" },
    },
    {
      role: "tool",
      content: "Done.",
      metadata: { sourceMessageId: "tool-result" },
    },
  ];

  const marked = markLatestExternalRequest(
    messages,
    history,
    { id: "east", name: "East", role: "assistant" } as Agent,
  );

  assertEquals(marked[0].content, [{
    type: "text",
    text: "Call a tool.",
    promptCacheBreakpoint: { mode: "explicit" },
  }]);
  assertEquals(marked[1].content, "Calling.");
  assertEquals(marked[2].content, "Done.");
});

Deno.test("markLatestExternalRequest treats peer-agent and job messages as initiators", () => {
  const history = [
    {
      id: "peer",
      threadId: "thread-1",
      senderId: "north",
      senderType: "agent",
    },
    {
      id: "job",
      threadId: "thread-1",
      senderId: "scheduler",
      senderType: "job",
    },
  ] satisfies NewMessage[];
  const messages: ChatMessage[] = history.map((message) => ({
    role: "user",
    content: message.id ?? "",
    metadata: { sourceMessageId: message.id },
  }));

  const marked = markLatestExternalRequest(
    messages,
    history,
    { id: "east", name: "East", role: "assistant" } as Agent,
  );

  assertEquals(marked[0].content, "peer");
  assertEquals(marked[1].content, [{
    type: "text",
    text: "job",
    promptCacheBreakpoint: { mode: "explicit" },
  }]);
});

Deno.test("buildTurnControlMessage omits unavailable consultation guidance", () => {
  const message = buildTurnControlMessage(
    { id: "solo", name: "Solo", role: "assistant" } as Agent,
    { metadata: {} } as unknown as Event,
    false,
  );

  assertStringIncludes(String(message.content), "returns_to: requester");
  assertEquals(String(message.content).includes("consult_agent"), false);
});
