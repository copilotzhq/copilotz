import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import type { RunInput } from "../attachments/index.ts";
import { type InteractiveCliIo, startInteractiveCli } from "../cli.ts";
import { createEphemeralEvent } from "../events/index.ts";

Deno.test("portable CLI preserves interactive run, rendering, and session commands", async () => {
  const answers = [
    "hello",
    "/agents",
    "/tools",
    "/skills",
    "/status",
    "/exit",
  ];
  const output: string[] = [];
  let ioClosed = 0;
  const io: InteractiveCliIo = Object.freeze({
    question: () => Promise.resolve(answers.shift() ?? "/exit"),
    write: (value) => output.push(value),
    close: () => {
      ioClosed += 1;
    },
    cwd: () => "/workspace",
  });
  const messages: RunInput[] = [];
  const handle = startInteractiveCli({
    io,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    scope: {
      namespace: "tenant-a",
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
    },
    inspect: () => ({
      agent: { id: "support", name: "Support" },
      agents: [],
      tools: [{ key: "lookup" }],
      skills: [{ name: "support-guide", description: "Support guidance" }],
    }),
    performRun(message) {
      messages.push(message);
      const event = createEphemeralEvent({
        type: "text.delta",
        namespace: "tenant-a",
        threadId: "thread-a",
        payload: { text: "hi", agent: { name: "Support" } },
        correlationId: "correlation-a",
      });
      return Promise.resolve({
        eventId: "event-a",
        threadId: "thread-a",
        correlationId: "correlation-a",
        outputs: new ReadableStream({
          start(controller) {
            controller.enqueue(event);
            controller.close();
          },
        }),
        done: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });

  await handle.closed;
  assertEquals(ioClosed, 1);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].content, "hello");
  assertEquals(messages[0].thread, "thread-a");
  assertEquals(messages[0].namespace, "tenant-a");
  const rendered = output.join("");
  assertStringIncludes(rendered, "Copilotz Interactive Session");
  assertStringIncludes(rendered, "assistant Support");
  assertStringIncludes(rendered, "answer>");
  assertStringIncludes(rendered, "last event id: event-a");
  assertStringIncludes(rendered, "Available tools: 1");
  assertStringIncludes(rendered, "support-guide: Support guidance");
  assertStringIncludes(rendered, "Ending session. Goodbye.");
});

Deno.test("portable CLI renders one labelled line for a streamed tool-call draft", async () => {
  const answers = ["what time is it?", "/exit"];
  const output: string[] = [];
  const io: InteractiveCliIo = Object.freeze({
    question: () => Promise.resolve(answers.shift() ?? "/exit"),
    write: (value) => output.push(value),
    close: () => undefined,
  });
  const agent = { name: "Support" };
  const frame = (
    type: "text.delta" | "tool_call.delta",
    payload: Record<string, unknown>,
  ) =>
    createEphemeralEvent({
      type,
      namespace: "tenant-a",
      threadId: "thread-a",
      payload: { ...payload, agent },
      correlationId: "correlation-a",
    });
  const events = [
    frame("text.delta", { text: "Checking now." }),
    frame("tool_call.delta", {
      providerAttemptId: "attempt-a",
      draftId: "attempt-a:0",
      callIndex: 0,
      sequence: 0,
      toolName: "get_current_time",
      phase: "start",
      delta: '{"name":"get_current_time"',
    }),
    frame("tool_call.delta", {
      providerAttemptId: "attempt-a",
      draftId: "attempt-a:0",
      callIndex: 0,
      sequence: 1,
      toolName: "get_current_time",
      phase: "delta",
      delta: ',"arguments":',
    }),
    frame("tool_call.delta", {
      providerAttemptId: "attempt-a",
      draftId: "attempt-a:0",
      callIndex: 0,
      sequence: 2,
      toolName: "get_current_time",
      phase: "delta",
      delta: '{"timezone":"local"}}',
    }),
    frame("tool_call.delta", {
      providerAttemptId: "attempt-a",
      draftId: "attempt-a:0",
      callIndex: 0,
      sequence: 3,
      toolName: "get_current_time",
      phase: "complete",
      delta: "",
      toolCallId: "call-a",
    }),
    frame("text.delta", { text: "It is noon." }),
  ];
  const handle = startInteractiveCli({
    io,
    scope: {
      namespace: "tenant-a",
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
    },
    performRun() {
      return Promise.resolve({
        eventId: "event-a",
        threadId: "thread-a",
        correlationId: "correlation-a",
        outputs: new ReadableStream({
          start(controller) {
            for (const event of events) controller.enqueue(event);
            controller.close();
          },
        }),
        done: Promise.resolve(),
        cancel: () => Promise.resolve(),
      });
    },
  });

  await handle.closed;
  const rendered = output.join("");
  assertEquals(rendered.match(/tool>\x1b\[0m get_current_time/g)?.length, 1);
  assertEquals(rendered.includes("tool>\x1b[0m tool"), false);
  assertEquals(rendered.match(/answer>/g)?.length, 2);
  assertStringIncludes(rendered, "It is noon.");
});

Deno.test("portable CLI is factory-first and imports no host terminal API", async () => {
  const source = await Deno.readTextFile(new URL("../cli.ts", import.meta.url));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  assert(!/from\s+["']node:|\bDeno\.|\bBun\.|\bprocess\./.test(source));
  assert(!/copilotz\.core|llm\.call/.test(source));
});
