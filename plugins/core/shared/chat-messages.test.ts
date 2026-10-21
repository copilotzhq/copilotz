import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ChatMessage,
  type ChatSender,
  chatSender,
  groupMessages,
  liveMessage,
  messageAttachments,
  messageText,
  ownMessagePredicate,
  projectMessages,
} from "./chat-messages.ts";

const sender = (
  id: string,
  type: ChatSender["type"],
  name = id,
): ChatSender => ({
  id,
  type,
  name,
  externalId: `ext-${id}`,
});
const north = sender("north", "agent", "North");
const south = sender("south", "agent", "South");
const ana = sender("ana", "human", "Ana");
const ben = sender("ben", "human", "Ben");
const message = (
  id: string,
  from: ChatSender,
  text = id,
): ChatMessage => ({
  id,
  role: from.type === "human" ? "user" : "assistant",
  sender: from,
  text,
  createdAt: "",
  attachments: [],
  activity: [],
  status: "sent",
});
const text = (value: string, role = "body") => ({
  assetId: `a-${value}`,
  kind: "text",
  role,
  mediaType: "text/plain",
  value,
});

test("consecutive messages by one speaker share a group; another speaker starts one", () => {
  const groups = groupMessages([
    message("n1", north),
    message("n2", north),
    message("s1", south),
    message("a1", ana),
    message("a2", ana),
    message("n3", north),
  ], () => true);
  assert.deepEqual(
    groups.map((group) => group.messages.map((value) => value.id)),
    [["n1", "n2"], ["s1"], ["a1", "a2"], ["n3"]],
  );
  assert.equal(groups[0].id, "n1");
  assert.equal(groups[2].own, true);
  assert.equal(groups[0].own, false, "agent messages are never own");
});

test("adjacent agents keep separate groups and avatars", () => {
  const groups = groupMessages(
    [message("e", north), message("s", south)],
    () => false,
  );
  assert.deepEqual(groups.map((group) => group.sender.id), ["north", "south"]);
});

test("one human sender keeps every human message as the reader's", () => {
  const own = ownMessagePredicate([ana, north], { externalId: "someone" });
  assert.equal(own(ana), true);
  assert.equal(own(north), false);
});

test("with several people, only the reader's messages are theirs, by id or external id", () => {
  assert.equal(ownMessagePredicate([ana, ben], { id: "ana" })(ben), false);
  assert.equal(ownMessagePredicate([ana, ben], { id: "ana" })(ana), true);
  assert.equal(
    ownMessagePredicate([ana, ben], { externalId: "ext-ben" })(ben),
    true,
  );
});

test("an unmatched reader falls back to every human message being theirs", () => {
  const own = ownMessagePredicate([ana, ben], { id: "nobody" });
  assert.equal(own(ana), true);
  assert.equal(own(ben), true);
});

test("text skips reasoning and assets; attachments keep references", () => {
  const content = [
    text("Hello"),
    text("hidden thought", "reasoning"),
    {
      assetId: "img",
      kind: "image",
      role: "attachment",
      mediaType: "image/png",
      name: "chart.png",
      metadata: { byteLength: 42 },
    },
    text("world"),
  ];
  assert.equal(messageText(content), "Hello\n\nworld");
  assert.deepEqual(messageAttachments(content), [{
    kind: "image",
    mediaType: "image/png",
    name: "chart.png",
    size: 42,
    assetId: "img",
  }]);
  assert.equal(messageText("plain"), "plain");
});

test("participant rows become senders with stable fallbacks", () => {
  assert.deepEqual(
    chatSender({
      id: "p",
      participantType: "agent",
      name: "North",
      agentId: "north",
    }, "p"),
    { id: "p", type: "agent", name: "North", agentId: "north" },
  );
  assert.equal(chatSender(undefined, "x").name, "Participant");
  assert.equal(chatSender(undefined, "x").type, "system");
});

test("tool results fold into their call; failures and internal rows project correctly", () => {
  const senders: Record<string, ChatSender> = {
    ana,
    north,
    tool: sender("tool", "tool", "kanban"),
  };
  const rows = [
    { id: "u", senderId: "ana", content: [text("Plan it")] },
    {
      id: "a",
      senderId: "north",
      content: [text("Done.")],
      metadata: {
        copilotzWorkflow: { kind: "agent_output", llmAttemptId: "run-1" },
        llmReasoning: [text("Think first", "reasoning")],
        llmToolCalls: [
          { id: "c1", action: "kanban", input: { name: "Cycle" } },
          { id: "c2", action: "search", input: {} },
        ],
      },
    },
    {
      id: "r1",
      senderId: "tool",
      content: [text("created")],
      metadata: { toolInvocation: { id: "c1" }, toolStatus: "completed" },
    },
    {
      id: "r2",
      senderId: "tool",
      content: [text("timeout")],
      metadata: { toolInvocation: { id: "c2" }, toolStatus: "failed" },
    },
    {
      id: "hidden",
      senderId: "north",
      visibility: { kind: "internal" },
      content: [text("secret")],
    },
    {
      id: "failed",
      senderId: "north",
      content: [],
      metadata: {
        copilotzWorkflow: { kind: "agent_failure", outcome: "failed" },
      },
    },
    { id: "empty", senderId: "north", content: [] },
  ];
  const messages = projectMessages(rows, (id) => senders[id]);
  assert.deepEqual(messages.map((value) => value.id), ["u", "a", "failed"]);
  const reply = messages[1];
  assert.equal(reply.attemptId, "run-1");
  assert.deepEqual(
    reply.activity.map((item) => [item.kind, item.status, item.toolId]),
    [
      ["thinking", "complete", undefined],
      ["tool", "complete", "kanban"],
      ["tool", "failed", "search"],
    ],
  );
  assert.equal(reply.activity[0].reasoning, "Think first");
  assert.equal(reply.activity[1].result, "created");
  assert.equal(reply.activity[2].error, "timeout");
  assert.equal(messages[2].activity[0].kind, "failure");
});

test("a live reply shows thinking, tool drafts and its text while streaming", () => {
  const live = liveMessage({
    attemptId: "run-9",
    operationId: "op",
    agent: { id: "north", name: "North" },
    text: "",
    reasoning: "",
    tools: [],
    status: "streaming",
    candidate: 0,
    startedAt: 0,
    updatedAt: 0,
  }, north);
  assert.deepEqual(live.activity.map((item) => [item.kind, item.status]), [[
    "thinking",
    "active",
  ]]);
  const working = liveMessage({
    attemptId: "run-9",
    operationId: "op",
    text: "Running",
    reasoning: "Plan",
    tools: [{
      id: "d1",
      name: "terminal",
      input: '{"stdin":"ls"}',
      phase: "complete",
      toolCallId: "c9",
    }],
    status: "streaming",
    candidate: 0,
    startedAt: 0,
    updatedAt: 0,
  }, north);
  assert.equal(working.status, "streaming");
  assert.deepEqual(working.activity.map((item) => [item.id, item.status]), [
    ["run-9:thinking", "complete"],
    ["c9", "active"],
  ]);
  assert.deepEqual(working.activity[1].input, { stdin: "ls" });
});
