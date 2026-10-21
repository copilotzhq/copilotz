import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatSender } from "../../shared/chat-messages.ts";
import {
  type ConfiguredAgent,
  mentionTargets,
  resolveRecipients,
} from "./recipients.ts";

const north: ChatSender = {
  id: "p-north",
  type: "agent",
  name: "North",
  agentId: "north",
  externalId: "north",
};
const west: ChatSender = {
  ...north,
  id: "p-west",
  name: "West",
  agentId: "west",
  externalId: "west",
};
const configured: ConfiguredAgent[] = [
  { externalId: "north", agentId: "north", name: "North" },
  { externalId: "west", agentId: "west", name: "West", default: true },
  { externalId: "east", agentId: "east", name: "East" },
];

test("mention targets: the thread's readable agents, then configured ones by external id", () => {
  assert.deepEqual(
    mentionTargets([north], configured).map((target) => target.id),
    ["p-north", "agent:west", "agent:east"],
  );
});

test("a mention addresses exactly the mentioned agents", () => {
  assert.deepEqual(
    resolveRecipients({
      mentioned: ["p-north", "agent:east"],
      threadAgents: [north],
      configured,
      policy: "first",
    }),
    { recipientIds: ["p-north"], agents: [configured[2]] },
  );
});

test("without a mention, `first` addresses the default agent only; `all` leaves Core's default", () => {
  const base = { mentioned: [], configured };
  // The flagged default, when it is in the thread.
  assert.deepEqual(
    resolveRecipients({
      ...base,
      threadAgents: [north, west],
      policy: "first",
    }),
    { recipientIds: ["p-west"], agents: [] },
  );
  // Otherwise the thread's first agent.
  assert.deepEqual(
    resolveRecipients({ ...base, threadAgents: [north], policy: "first" }),
    { recipientIds: ["p-north"], agents: [] },
  );
  // People unreadable: the configured default, by external id.
  assert.deepEqual(
    resolveRecipients({ ...base, threadAgents: [], policy: "first" }),
    { recipientIds: [], agents: [configured[1]] },
  );
  assert.equal(
    resolveRecipients({ ...base, threadAgents: [north], policy: "all" }),
    undefined,
  );
});
