import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  EVENT_PRIORITIES,
  priorityForAgentLlmCall,
  priorityForInboundMessage,
} from "@/runtime/event-priority.ts";

Deno.test("priorityForInboundMessage gives human input the conversational turn", () => {
  assertEquals(
    priorityForInboundMessage({ sender: { type: "user", name: "User" } }),
    EVENT_PRIORITIES.USER_INPUT,
  );
});

Deno.test("priorityForInboundMessage treats tool messages as settlement work", () => {
  assertEquals(
    priorityForInboundMessage({ sender: { type: "tool", name: "Tool" } }),
    EVENT_PRIORITIES.SETTLEMENT,
  );
});

Deno.test("priorityForAgentLlmCall keeps user-originated calls above agent continuations", () => {
  assertEquals(
    priorityForAgentLlmCall({ sender: { type: "user", name: "User" } }),
    EVENT_PRIORITIES.USER_INPUT,
  );
  assertEquals(
    priorityForAgentLlmCall({ sender: { type: "agent", name: "Agent" } }),
    EVENT_PRIORITIES.AGENT_CONTINUATION,
  );
});
