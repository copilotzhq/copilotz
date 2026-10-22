import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeedProjector, type FeedFrame } from "./chat-feed.ts";

const encoder = new TextEncoder();
let position = 0;
const checkpoint = () => String(++position);
const agent = (lane: string, attempt = "run-1", candidate = 0) => ({
  llmAttemptId: attempt,
  lane,
  providerAttemptIndex: candidate,
  copilotzCore: {
    schema: "copilotz.core.llm-stream.v1",
    agent: { id: "north", name: "North" },
  },
});
const open = (
  streamId: string,
  metadata: Record<string, unknown>,
  operationId = "op-1",
): FeedFrame => ({
  kind: "output",
  checkpoint: checkpoint(),
  output: {
    type: "stream.output",
    operationId,
    streamId,
    role: String(metadata.lane ?? metadata.channel ?? "output"),
    kind: "text",
    mediaType: "text/plain",
    metadata,
  },
});
const chunk = (
  streamId: string,
  offset: number,
  text: string | Uint8Array,
) => ({
  kind: "stream-chunk" as const,
  streamId,
  offset,
  bytes: typeof text === "string" ? encoder.encode(text) : text,
  checkpoint: checkpoint(),
});
const end = (streamId: string, offset: number, failed = false): FeedFrame => ({
  kind: failed ? "stream-error" : "stream-end",
  streamId,
  offset,
  terminal: { outcome: failed ? "failed" : "completed" },
  checkpoint: checkpoint(),
});
const event = (
  type: string,
  extra: Record<string, unknown> = {},
): FeedFrame => ({
  kind: "output",
  checkpoint: checkpoint(),
  output: { type, operationId: "op-1", ...extra },
});

test("text, reasoning and the agent arrive by lane; replayed bytes apply once", () => {
  const feed = createFeedProjector(() => 1);
  feed.apply(open("r", agent("reasoning")));
  feed.apply(chunk("r", 0, "Plan "));
  feed.apply(chunk("r", 0, "Plan first")); // overlapping replay
  feed.apply(end("r", 10));
  feed.apply(open("c", agent("content")));
  feed.apply(chunk("c", 0, "Hello"));
  feed.apply(chunk("c", 5, ", world"));
  const [reply] = feed.snapshot().attempts;
  assert.equal(reply.text, "Hello, world");
  assert.equal(reply.reasoning, "Plan first");
  assert.deepEqual(reply.agent, { id: "north", name: "North" });
  assert.equal(
    reply.status,
    "streaming",
    "an ended lane never settles the reply",
  );
  assert.deepEqual(feed.snapshot().active, ["op-1"]);
});

test("a byte gap is refused rather than spliced", () => {
  const feed = createFeedProjector();
  feed.apply(open("c", agent("content")));
  feed.apply(chunk("c", 0, "ab"));
  assert.throws(() => feed.apply(chunk("c", 5, "zz")), RangeError);
});

test("a multi-byte character split across chunks decodes intact", () => {
  const feed = createFeedProjector();
  feed.apply(open("c", agent("content")));
  const bytes = encoder.encode("é✓");
  feed.apply(chunk("c", 0, bytes.slice(0, 1)));
  feed.apply(chunk("c", 1, bytes.slice(1, 4)));
  feed.apply(chunk("c", 4, bytes.slice(4)));
  assert.equal(feed.snapshot().attempts[0].text, "é✓");
});

test("tool-call drafts stream as NDJSON; discarded drafts disappear", () => {
  const feed = createFeedProjector();
  feed.apply(open("t", agent("tool-calls")));
  const lines = [
    { draftId: "d1", toolName: "terminal", phase: "start", delta: "" },
    { draftId: "d1", toolName: "terminal", phase: "delta", delta: '{"stdin":' },
    {
      draftId: "d1",
      toolName: "terminal",
      phase: "complete",
      delta: '"ls"}',
      toolCallId: "c1",
    },
    { draftId: "d2", toolName: "search", phase: "start", delta: "" },
    { draftId: "d2", toolName: "search", phase: "discarded", delta: "" },
  ].map((line) => JSON.stringify(line) + "\n").join("");
  // Split mid-line: the partial line waits for the rest.
  feed.apply(chunk("t", 0, lines.slice(0, 40)));
  feed.apply(
    chunk("t", encoder.encode(lines.slice(0, 40)).length, lines.slice(40)),
  );
  feed.apply(end("t", encoder.encode(lines).length));
  assert.deepEqual(feed.snapshot().attempts[0].tools, [{
    id: "d1",
    name: "terminal",
    input: '{"stdin":"ls"}',
    phase: "complete",
    toolCallId: "c1",
  }]);
});

test("a provider fallback replaces the earlier candidate's provisional output", () => {
  const feed = createFeedProjector();
  feed.apply(open("c0", agent("content", "run-1", 0)));
  feed.apply(chunk("c0", 0, "partial from the first model"));
  feed.apply(open("c1", agent("content", "run-1", 1)));
  feed.apply(chunk("c1", 0, "Fresh"));
  feed.apply(chunk("c0", 28, " late bytes"));
  assert.equal(feed.snapshot().attempts[0].text, "Fresh");
  assert.equal(feed.snapshot().attempts[0].candidate, 1);
});

test("tool output follows the tool call through its Action run", () => {
  const feed = createFeedProjector();
  feed.apply(event("action.invoked", {
    data: {
      actionRunId: "run-tool",
      metadata: { copilotzToolAction: { toolCallId: "c1" } },
    },
  }));
  feed.apply(open("out", { sourceActionRunId: "run-tool", channel: "stdout" }));
  feed.apply(chunk("out", 0, "line 1\n"));
  feed.apply(chunk("out", 7, "line 2\n"));
  assert.deepEqual(feed.snapshot().outputs, {
    c1: { stdout: "line 1\nline 2\n" },
  });
  assert.equal(
    feed.snapshot().attempts.length,
    0,
    "tool output is not a reply",
  );
});

test("only terminal LLM and operation events settle replies across failed stream attempts", () => {
  const feed = createFeedProjector();
  feed.apply(open("a", agent("content", "run-a")));
  feed.apply(open("b", agent("content", "run-b")));
  feed.apply(open("c", agent("content", "run-c")));
  feed.apply(event("llm.call.completed", { data: { actionRunId: "run-a" } }));
  feed.apply(end("b", 0, true));
  assert.equal(
    feed.snapshot().attempts.find((attempt) => attempt.attemptId === "run-b")
      ?.status,
    "streaming",
  );
  feed.apply(event("operation.settled", { outcome: "cancelled" }));
  const status = Object.fromEntries(
    feed.snapshot().attempts.map((
      attempt,
    ) => [attempt.attemptId, attempt.status]),
  );
  assert.deepEqual(status, {
    "run-a": "complete",
    "run-b": "failed",
    "run-c": "failed",
  });
  assert.deepEqual(feed.snapshot().active, []);
  // A settled operation does not come back from a late output.
  feed.apply(event("message.created"));
  assert.deepEqual(feed.snapshot().active, []);
  assert.equal(feed.forget(["run-a"]), true);
  assert.deepEqual(
    feed.snapshot().attempts.map((attempt) => attempt.attemptId),
    ["run-b", "run-c"],
  );
});

test("snapshots are plain, cloneable data", () => {
  const feed = createFeedProjector();
  feed.apply(open("c", agent("content")));
  feed.apply(chunk("c", 0, "x"));
  const snapshot = feed.snapshot();
  assert.deepEqual(structuredClone(snapshot), snapshot);
});
