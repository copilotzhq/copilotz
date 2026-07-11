import { assertEquals } from "@std/assert";

import {
  buildToolReplyRoutingMetadata,
  normalizeRoutingDecision,
  resolveNextTurn,
  resolveThreadParticipantTarget,
} from "./message.created.ts";
import type { Agent, Thread } from "@/types/index.ts";

const agents: Agent[] = [
  agent("north"),
  agent("south"),
  agent("east"),
  agent("west"),
];

function agent(id: string): Agent {
  return {
    id,
    name: id,
    role: "assistant",
    instructions: `${id} instructions.`,
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
  };
}

function thread(metadata: unknown = {}): Thread {
  return {
    id: "thread-1",
    name: "Main Thread",
    participants: ["north", "south", "east", "west", "vfssantos"],
    metadata,
  } as unknown as Thread;
}

const decision = (action: "ask" | "handoff", targetId: string) => ({
  action,
  targetId,
  source: "model_control" as const,
});

Deno.test("normalizeRoutingDecision accepts only the singular ask/handoff contract", () => {
  assertEquals(
    normalizeRoutingDecision({
      action: "ask",
      targetId: " south ",
      source: "model_control",
      controlCallId: " call-1 ",
    }),
    {
      action: "ask",
      targetId: "south",
      source: "model_control",
      controlCallId: "call-1",
    },
  );
  assertEquals(
    normalizeRoutingDecision({ routeTo: ["south"] }),
    null,
  );
  assertEquals(
    normalizeRoutingDecision({ action: "ask", targetId: "south" }),
    null,
  );
  assertEquals(
    normalizeRoutingDecision({ action: "broadcast", targetId: "south" }),
    null,
  );
});

Deno.test("resolveThreadParticipantTarget preserves a user return target for legacy threads with one human participant", () => {
  const availableAgents: Agent[] = [
    agent("reviewer"),
    agent("generalist-genius"),
  ];

  const legacyThread = {
    id: "thread-1",
    name: "Main Thread",
    participants: ["reviewer", "generalist-genius"],
    metadata: {
      system: {
        memory: {
          identity: {
            userExternalId: "User",
          },
        },
      },
    },
  } as unknown as Thread;

  assertEquals(
    resolveThreadParticipantTarget("User", legacyThread, availableAgents),
    "User",
  );
});

Deno.test("resolveNextTurn applies ask and prepends the asker to the return path", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      routingDecision: decision("ask", "south"),
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "south",
      returnPath: ["north", "vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn applies handoff without adding the sender to the return path", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      routingDecision: decision("handoff", "south"),
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "south",
      returnPath: ["vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn advances an agent reply through the queued return path", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "south", name: "south", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "south", returnPath: ["north", "vfssantos"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "north",
      returnPath: ["vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn exits to the human when the queue resolves to a user participant", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "human",
      targetId: "vfssantos",
    },
  );
});

Deno.test("resolveNextTurn preserves deferred agent routing after a tool-result self return", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["south", "vfssantos"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "south",
      returnPath: ["vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn treats handoff to user as an explicit human handoff", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: [] },
      routingDecision: decision("handoff", "user"),
      multiAgentEnabled: true,
    }),
    {
      kind: "human",
      targetId: "vfssantos",
    },
  );
});

Deno.test("resolveNextTurn enforces allowedAgents for explicit agent routing", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: [
        { ...agent("north"), allowedAgents: ["east"] },
        agent("south"),
        agent("east"),
      ],
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      routingDecision: decision("handoff", "south"),
      multiAgentEnabled: true,
    }),
    { kind: "stop" },
  );
});

Deno.test("resolveNextTurn treats null and empty allowedAgents as no agent routes", () => {
  for (const allowedAgents of [null, [] as string[]]) {
    assertEquals(
      resolveNextTurn({
        sender: { id: "north", name: "north", type: "agent" },
        thread: thread(),
        availableAgents: [
          { ...agent("north"), allowedAgents },
          agent("south"),
        ],
        inbound: { targetId: "north", returnPath: ["vfssantos"] },
        routingDecision: decision("handoff", "south"),
        multiAgentEnabled: true,
      }),
      { kind: "stop" },
    );
  }
});

Deno.test("resolveNextTurn rejects self-routing decisions", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      routingDecision: decision("handoff", "north"),
      multiAgentEnabled: true,
    }),
    { kind: "stop" },
  );
});

Deno.test("resolveNextTurn rejects asking a human because no automatic return can be guaranteed", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      routingDecision: decision("ask", "user"),
      multiAgentEnabled: true,
    }),
    { kind: "stop" },
  );
});

Deno.test("resolveNextTurn ignores explicit agent routes outside the thread participants", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: {
        ...thread(),
        participants: ["north", "vfssantos"],
      } as Thread,
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: ["vfssantos"] },
      routingDecision: decision("handoff", "south"),
      multiAgentEnabled: true,
    }),
    { kind: "stop" },
  );
});

Deno.test("resolveNextTurn ignores removed participantTargets metadata", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "vfssantos", name: "Vitor", type: "user" },
      thread: thread({ participantTargets: { vfssantos: "east" } }),
      availableAgents: agents,
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "north",
      returnPath: [],
    },
  );
});

Deno.test("resolveNextTurn does not self-route agent messages when multi-agent routing is disabled", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", returnPath: [] },
      multiAgentEnabled: false,
    }),
    { kind: "stop" },
  );
});

Deno.test("resolveNextTurn still routes tool results back to the requesting agent when multi-agent routing is disabled", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "Tool result", type: "tool" },
      thread: thread(),
      availableAgents: agents,
      inbound: { replyToParticipantId: "north", replyToReturnPath: [] },
      multiAgentEnabled: false,
    }),
    {
      kind: "agent",
      targetId: "north",
      returnPath: [],
    },
  );
});

Deno.test("buildToolReplyRoutingMetadata returns tool results to the emitter while preserving the deferred turn", () => {
  assertEquals(
    buildToolReplyRoutingMetadata("north", {
      kind: "agent",
      targetId: "south",
      returnPath: ["vfssantos"],
    }),
    {
      replyToParticipantId: "north",
      replyToTargetQueue: ["south", "vfssantos"],
    },
  );
});

Deno.test("buildToolReplyRoutingMetadata preserves a direct human return after the emitter", () => {
  assertEquals(
    buildToolReplyRoutingMetadata("north", {
      kind: "human",
      targetId: "vfssantos",
    }),
    {
      replyToParticipantId: "north",
      replyToTargetQueue: ["vfssantos"],
    },
  );
});
