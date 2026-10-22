import { test } from "node:test";
import assert from "node:assert/strict";
import {
  type ChatMessage,
  type ChatSender,
  chatSender,
  finishedReplies,
  groupMessages,
  liveMessage,
  messageAttachments,
  messageText,
  ownMessagePredicate,
  projectMessages,
  settleFinished,
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
  // An unread participant (a refused read) is neutral, never a bot.
  assert.deepEqual(chatSender(undefined, "x"), {
    id: "x",
    type: "human",
    name: "Someone",
    unknown: true,
  });
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

test("JSON tool results pass through: a resolved value as data, a reference to read on demand", () => {
  const senders: Record<string, ChatSender> = {
    north,
    tool: sender("tool", "tool", "terminal"),
  };
  const json = (id: string, extra: Record<string, unknown>) => ({
    id: `r-${id}`,
    senderId: "tool",
    content: [{
      assetId: `j-${id}`,
      kind: "json",
      role: "tool.output",
      mediaType: "application/json",
      ...extra,
    }],
    metadata: { toolInvocation: { id }, toolStatus: "completed" },
  });
  const [reply] = projectMessages([
    {
      id: "a",
      senderId: "north",
      content: [],
      metadata: {
        llmToolCalls: [
          { id: "c1", action: "terminal", input: {} },
          { id: "c2", action: "terminal", input: {} },
        ],
      },
    },
    json("c1", { value: { stdout: "ok", exitCode: 0 } }),
    json("c2", { resolve: false }),
  ], (id) => senders[id]);
  assert.deepEqual(reply.activity[0].data, { stdout: "ok", exitCode: 0 });
  assert.equal(reply.activity[0].resultRef, undefined);
  assert.deepEqual(reply.activity[1].resultRef, {
    messageId: "r-c2",
    assetId: "j-c2",
  });
  assert.equal(reply.activity[1].data, undefined);
});

test("a status-only tool result keeps its input and status, and withholds its output from anyone but the requester", () => {
  const senders: Record<string, ChatSender> = {
    north,
    tool: sender("tool", "tool", "search_memory"),
  };
  const rows = [
    {
      id: "a",
      senderId: "north",
      content: [],
      metadata: {
        llmToolCalls: [
          { id: "c1", action: "search_memory", input: { limit: 20 } },
          { id: "c2", action: "search_memory", input: { limit: 5 } },
        ],
      },
    },
    ...["c1", "c2"].map((id) => ({
      id: `r-${id}`,
      senderId: "tool",
      visibility: {
        kind: "tool",
        policy: id === "c1" ? "public_status" : "public",
        requesterId: "north",
      },
      content: [{
        assetId: `j-${id}`,
        kind: "json",
        role: "tool.output",
        mediaType: "application/json",
        resolve: false,
      }],
      metadata: { toolInvocation: { id }, toolStatus: "completed" },
    })),
  ];
  const [person] = projectMessages(rows, (id) => senders[id], {
    viewerIds: ["ana", "ext-ana"],
  });
  assert.equal(person.activity[0].status, "complete");
  assert.deepEqual(person.activity[0].input, { limit: 20 });
  assert.equal(person.activity[0].resultStatus, "restricted");
  assert.equal(person.activity[0].resultRef, undefined, "nothing to read");
  assert.ok(person.activity[1].resultRef, "a public result reads as before");
  const [agent] = projectMessages(rows, (id) => senders[id], {
    viewerIds: ["north"],
  });
  assert.equal(agent.activity[0].resultStatus, undefined);
  assert.deepEqual(agent.activity[0].resultRef, {
    messageId: "r-c1",
    assetId: "j-c1",
  });
});

test("a withheld output names who may read it; calls carry when they ran", () => {
  const senders: Record<string, ChatSender> = {
    north,
    ana,
    tool: sender("tool", "tool", "search_memory"),
  };
  const visibility = {
    kind: "tool",
    policy: "public_status",
    requesterId: "north",
    initiatorId: "ana",
  };
  const rows = [
    {
      id: "a",
      senderId: "north",
      createdAt: "2026-10-21T10:00:00.000Z",
      content: [],
      metadata: {
        llmToolCalls: [
          { id: "c1", action: "search_memory", input: {} },
          { id: "c2", action: "terminal", input: {}, visibility },
        ],
      },
    },
    {
      id: "r-c1",
      senderId: "tool",
      createdAt: "2026-10-21T10:00:03.000Z",
      visibility,
      content: [{
        assetId: "j-c1",
        kind: "json",
        role: "tool.output",
        mediaType: "application/json",
        resolve: false,
      }],
      metadata: { toolInvocation: { id: "c1" }, toolStatus: "completed" },
    },
  ];
  const [initiator] = projectMessages(rows, (id) => senders[id], {
    viewerIds: ["ana"],
  });
  assert.ok(initiator.activity[0].resultRef, "Ana asked: she reads it");
  assert.equal(initiator.activity[0].withheld, undefined);
  assert.equal(initiator.activity[0].startedAt, "2026-10-21T10:00:00.000Z");
  assert.equal(initiator.activity[0].endedAt, "2026-10-21T10:00:03.000Z");
  const [other] = projectMessages(rows, (id) => senders[id], {
    viewerIds: ["ben"],
  });
  assert.equal(other.activity[0].resultStatus, "restricted");
  assert.equal(other.activity[0].withheld, true);
  assert.equal(other.activity[0].readableBy, "Ana");
  assert.equal(other.activity[0].resultRef, undefined, "nothing to read");
  // The call's own visibility says so before any result: a live view shows
  // its status alone.
  assert.equal(other.activity[1].status, "active");
  assert.equal(other.activity[1].withheld, true);
  assert.equal(other.activity[1].readableBy, "Ana");
  // A retained result without an initiator grants no initiator access.
  const [retained] = projectMessages(
    [rows[0], {
      ...rows[1],
      content: [],
      visibility: {
        kind: "tool",
        policy: "public_status",
        requesterId: "north",
      },
    }],
    (id) => senders[id],
    { viewerIds: ["ana"] },
  );
  assert.equal(
    retained.activity[0].status,
    "complete",
    "its status still shows",
  );
  assert.equal(retained.activity[0].resultStatus, "restricted");
  assert.equal(retained.activity[0].readableBy, undefined, "the agent's only");
});

test("a finished reply never shows a step still running", () => {
  const call = (id: string, from: ChatSender): ChatMessage => ({
    ...message(id, from),
    activity: [
      { id: `${id}-t`, kind: "tool", status: "active", toolId: "terminal" },
      { id: `${id}-d`, kind: "tool", status: "complete", toolId: "kanban" },
    ],
  });
  const messages = [call("a", north), message("q", ana), call("b", north)];
  // North wrote again after "a": its tools settled, statuses or not.
  const busy = settleFinished(messages, finishedReplies(messages, false));
  assert.deepEqual(busy[0].activity.map((item) => item.status), [
    "complete",
    "complete",
  ]);
  assert.equal(busy[0].activity[0].resultStatus, "restricted");
  assert.equal(busy[2].activity[0].status, "active", "the latest still runs");
  // An idle thread settles every reply.
  const idle = settleFinished(messages, finishedReplies(messages, true));
  assert.equal(idle[2].activity[0].status, "complete");
  assert.equal(idle[1], messages[1], "untouched messages are kept");
});

test("text a budgeted read deferred stays in order, to load on demand", () => {
  const deferredText = (assetId: string) => ({
    assetId,
    kind: "text",
    role: "body",
    mediaType: "text/markdown",
    resolve: false,
    deferred: "budget",
    byteLength: 4096,
  });
  const senders: Record<string, ChatSender> = {
    north,
    tool: sender("tool", "tool", "search"),
  };
  const messages = projectMessages([
    {
      id: "a",
      senderId: "north",
      content: [text("First"), deferredText("later")],
      metadata: { llmToolCalls: [{ id: "c1", action: "search", input: {} }] },
    },
    { id: "b", senderId: "north", content: [deferredText("only")] },
    {
      id: "r",
      senderId: "tool",
      content: [deferredText("result")],
      metadata: { toolInvocation: { id: "c1" }, toolStatus: "completed" },
    },
  ], (id) => senders[id]);
  assert.deepEqual(messages.map((message) => message.id), ["a", "b"]);
  assert.equal(messages[0].text, "First");
  assert.deepEqual(messages[0].pending, [
    { text: "First" },
    { assetId: "later", byteLength: 4096 },
  ]);
  assert.equal(messages[1].text, "", "kept, though nothing is read yet");
  assert.deepEqual(messages[0].activity[0].resultRef, {
    messageId: "r",
    assetId: "result",
    kind: "text",
  });
});

test("unread senders take a neutral identity from what their message says", () => {
  const unknown = (id: string) => chatSender(undefined, id);
  const messages = projectMessages([
    { id: "h", senderId: "p1", content: [text("Hello")] },
    {
      id: "a",
      senderId: "p2",
      content: [text("Reply")],
      metadata: { copilotzWorkflow: { kind: "agent_output" } },
    },
  ], unknown);
  assert.deepEqual(
    messages.map((message) => [message.sender.type, message.sender.name]),
    [
      ["human", "Someone"],
      ["agent", "Agent"],
    ],
  );
});
