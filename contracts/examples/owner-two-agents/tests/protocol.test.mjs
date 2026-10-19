import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../dist/protocol.mjs";
const input = (model, phase = "START", results = []) => ({
  model,
  request: {
    messages: [{
      role: "user",
      content: [{ type: "text", text: `${phase}_DEMO runId=one` }],
    }, ...results],
  },
});
const result = (step, value) => ({
  role: "tool",
  toolCallId: `one-${step}`,
  content: [{ type: "json", value }],
});
const tool = (value) => value.toolCalls?.[0];
test("coordinator uses built-in time, persists a draft, asks the reviewer and publishes after the answer", () => {
  const messages = [];
  assert.equal(
    tool(decide(input("coordinator-script", "START", messages))).action,
    "get_current_time",
  );
  messages.push(result("clock", { iso: "2026-10-19T00:00:00.000Z" }));
  assert.deepEqual(
    tool(decide(input("coordinator-script", "START", messages))).input,
    { runId: "one", clock: "2026-10-19T00:00:00.000Z" },
  );
  messages.push(result("draft", { status: "draft" }));
  const ask = tool(decide(input("coordinator-script", "START", messages)));
  assert.equal(ask.action, "ask");
  assert.equal(ask.input.target, "reviewer");
  messages.push(result("ask", { answer: "Reviewed" }));
  assert.equal(
    tool(decide(input("coordinator-script", "START", messages))).action,
    "publishPlan",
  );
  messages.push(result("publish", { status: "published" }));
  assert.match(
    decide(input("coordinator-script", "START", messages)).content,
    /Published/,
  );
});
test("reviewer uses the built-in clock, reads owner state and refuses unconfirmed review results", () => {
  assert.equal(
    tool(decide(input("reviewer-script", "REVIEW"))).action,
    "get_current_time",
  );
  const clock = result("review-clock", { iso: "2026-10-19T00:01:00.000Z" });
  assert.equal(
    tool(decide(input("reviewer-script", "REVIEW", [clock]))).action,
    "readPlan",
  );
  const read = result("read", { status: "draft" });
  const review = tool(
    decide(input("reviewer-script", "REVIEW", [clock, read])),
  );
  assert.equal(review.action, "reviewPlan");
  assert.equal(review.input.clock, "2026-10-19T00:01:00.000Z");
  assert.match(
    decide(
      input("reviewer-script", "REVIEW", [
        clock,
        read,
        result("review", { status: "reviewed" }),
      ]),
    ).content,
    /rollback/,
  );
  assert.throws(
    () =>
      decide(
        input("reviewer-script", "REVIEW", [clock, read, result("review", {})]),
      ),
    /did not confirm/,
  );
});

test("retries are deterministic and failure results never become success claims", () => {
  const request = input("coordinator-script");
  assert.deepEqual(decide(request), decide(request));
  const failed = decide(
    input("coordinator-script", "START", [
      result("clock", { status: "failed", error: "denied" }),
    ]),
  );
  assert.equal(failed.toolCalls, undefined);
  assert.match(failed.content, /stopped/);
  assert.throws(
    () => decide({ model: "coordinator-script", request: { messages: [] } }),
    /marker/,
  );
});
test("enrollment introduces both real Agent resource models without tools", () => {
  for (const model of ["coordinator-script", "reviewer-script"]) {
    const reply = decide(input(model, "ENROLL"));
    assert.equal(reply.toolCalls, undefined);
    assert.match(reply.content, /enrolled/);
  }
});

test("cancelled tools stop the script without a successful reply", () => {
  const reply = decide(
    input("coordinator-script", "START", [
      result("clock", { status: "cancelled" }),
    ]),
  );
  assert.equal(reply.toolCalls, undefined);
  assert.match(reply.content, /stopped/);
});
