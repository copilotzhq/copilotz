import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  buildToolReplyRoutingMetadata,
  resolveNextTurn,
  resolveThreadParticipantTarget,
} from "./index.ts";
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

Deno.test("resolveNextTurn routes ask_to to the asked agent and queues the asker", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", targetQueue: ["vfssantos"] },
      routingIntent: { askTo: ["south"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "south",
      targetQueue: ["north", "vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn routes route_to without queuing the sender", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", targetQueue: ["vfssantos"] },
      routingIntent: { routeTo: ["south"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "south",
      targetQueue: ["vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn advances an agent reply through the queued return path", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "south", name: "south", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "south", targetQueue: ["north", "vfssantos"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "north",
      targetQueue: ["vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn exits to the human when the queue resolves to a user participant", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", targetQueue: ["vfssantos"] },
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
      inbound: { targetId: "north", targetQueue: ["south", "vfssantos"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "south",
      targetQueue: ["vfssantos"],
    },
  );
});

Deno.test("resolveNextTurn treats route_to user as an explicit human handoff", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "north", name: "north", type: "agent" },
      thread: thread(),
      availableAgents: agents,
      inbound: { targetId: "north", targetQueue: [] },
      routingIntent: { routeTo: ["user"] },
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
      inbound: { targetId: "north", targetQueue: ["vfssantos"] },
      routingIntent: { routeTo: ["south"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "human",
      targetId: "vfssantos",
    },
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
      inbound: { targetId: "north", targetQueue: ["vfssantos"] },
      routingIntent: { routeTo: ["south"] },
      multiAgentEnabled: true,
    }),
    {
      kind: "human",
      targetId: "vfssantos",
    },
  );
});

Deno.test("resolveNextTurn honors persisted user targets only for user-originated messages", () => {
  assertEquals(
    resolveNextTurn({
      sender: { id: "vfssantos", name: "Vitor", type: "user" },
      thread: thread({ participantTargets: { vfssantos: "east" } }),
      availableAgents: agents,
      multiAgentEnabled: true,
    }),
    {
      kind: "agent",
      targetId: "east",
      targetQueue: [],
    },
  );
});

Deno.test("buildToolReplyRoutingMetadata returns tool results to the emitter while preserving the deferred turn", () => {
  assertEquals(
    buildToolReplyRoutingMetadata("north", {
      kind: "agent",
      targetId: "south",
      targetQueue: ["vfssantos"],
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
