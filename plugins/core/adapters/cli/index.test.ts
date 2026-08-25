import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { type InteractiveCliIo, startInteractiveCli } from "./index.ts";
import type { ApplicationOutput } from "@copilotz/copilotz/application";
import { createEphemeralEvent } from "@copilotz/copilotz/events";
import type { CoreMessageInputEnvelope } from "../../../core-collections/authoring/message-input/index.ts";

const encoder = new TextEncoder();

function stripCliFormatting(value: string): string {
  for (
    const sequence of [
      "\x1b[0m",
      "\x1b[1m",
      "\x1b[2m",
      "\x1b[32m",
      "\x1b[33m",
      "\x1b[35m",
      "\x1b[36m",
    ]
  ) value = value.replaceAll(sequence, "");
  return value;
}

function streamedText(
  role: "content" | "reasoning",
  streamId: string,
  chunks: readonly string[],
  agent?: Readonly<{ id: string; name: string }>,
): ApplicationOutput {
  return Object.freeze({
    type: "stream.output" as const,
    namespace: "tenant-a",
    streamId,
    mediaType: "text/plain",
    kind: "text" as const,
    role,
    correlationId: "correlation-a",
    metadata: Object.freeze({
      lane: role,
      ...(agent
        ? {
          copilotzCore: {
            schema: "copilotz.core.llm-stream.v1",
            agent,
          },
        }
        : {}),
    }),
    payload: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  });
}

function streamedToolCalls(
  chunks: readonly string[],
  agent?: Readonly<{ id: string; name: string }>,
): ApplicationOutput {
  return Object.freeze({
    type: "stream.output" as const,
    namespace: "tenant-a",
    streamId: "tool-calls-a",
    mediaType: "application/x-ndjson",
    kind: "text" as const,
    role: "tool-calls",
    correlationId: "correlation-a",
    metadata: Object.freeze({
      lane: "tool-calls",
      ...(agent
        ? {
          copilotzCore: {
            schema: "copilotz.core.llm-stream.v1",
            agent,
          },
        }
        : {}),
    }),
    payload: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  });
}

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
  const messages: CoreMessageInputEnvelope[] = [];
  const handle = startInteractiveCli({
    io,
    now: () => new Date("2026-08-06T00:00:00.000Z"),
    scope: {
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
    application: Object.freeze({
      namespace: "tenant-a",
      send(input: CoreMessageInputEnvelope) {
        messages.push(input);
        const event = createEphemeralEvent({
          type: "text.delta",
          namespace: "tenant-a",
          threadId: "thread-a",
          payload: { text: "hi", agent: { name: "Support" } },
          correlationId: "correlation-a",
        });
        return Promise.resolve({
          eventId: "event-a",
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
    }),
  });

  await handle.closed;
  assertEquals(ioClosed, 1);
  assertEquals(messages.length, 1);
  assertEquals(messages.at(0)!.payload!.content, "hello");
  assertEquals(messages.at(0)!.payload!.thread, "thread-a");
  const rendered = output.join("");
  assertStringIncludes(rendered, "Copilotz Interactive Session");
  assertStringIncludes(rendered, "Support>");
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
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
    },
    application: Object.freeze({
      namespace: "tenant-a",
      send() {
        return Promise.resolve({
          eventId: "event-a",
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
    }),
  });

  await handle.closed;
  const rendered = output.join("");
  assertEquals(rendered.split("tool>\x1b[0m get_current_time").length - 1, 1);
  assertEquals(rendered.includes("tool>\x1b[0m tool"), false);
  assertEquals(rendered.match(/Support>/g)?.length, 2);
  assertStringIncludes(rendered, "It is noon.");
});

Deno.test("portable CLI renders tool-call NDJSON as one safe tool block", async () => {
  const answers = ["what time is it?", "/exit"];
  const output: string[] = [];
  const io: InteractiveCliIo = Object.freeze({
    question: () => Promise.resolve(answers.shift() ?? "/exit"),
    write: (value) => output.push(value),
    close: () => undefined,
  });
  const frames = [{
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 0,
    toolName: "get_current_time",
    phase: "start",
    delta: '{"name":"get_current_time"',
    action: "get_current_time",
  }, {
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 1,
    toolName: "get_current_time",
    phase: "delta",
    delta: ',"arguments":{"timezone":"local"}}',
    action: "get_current_time",
  }, {
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 2,
    toolName: "get_current_time",
    phase: "complete",
    delta: "",
    toolCallId: "call-a",
    action: "get_current_time",
  }];
  const ndjson = frames.map((frame) => JSON.stringify(frame) + "\n").join("");
  const outputs = [
    streamedText("content", "content-before-tool", ["Checking now."]),
    streamedToolCalls([
      ndjson.slice(0, 19),
      ndjson.slice(19, 121),
      ndjson.slice(121),
    ]),
    streamedText("content", "content-after-tool", ["It is noon."]),
  ];
  const handle = startInteractiveCli({
    io,
    scope: {
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
    },
    application: Object.freeze({
      namespace: "tenant-a",
      send() {
        return Promise.resolve({
          eventId: "event-a",
          correlationId: "correlation-a",
          outputs: new ReadableStream<ApplicationOutput>({
            start(controller) {
              for (const stream of outputs) controller.enqueue(stream);
              controller.close();
            },
          }),
          done: Promise.resolve(),
          cancel: () => Promise.resolve(),
        });
      },
    }),
  });

  await handle.closed;
  const rendered = stripCliFormatting(output.join(""));
  assertEquals(rendered.split("tool> get_current_time").length - 1, 1);
  assertStringIncludes(
    rendered,
    "agent-a> Checking now.\ntool> get_current_time",
  );
  assertStringIncludes(
    rendered,
    "tool> get_current_time\nagent-a> It is noon.",
  );
  assertEquals(rendered.includes("providerAttemptId"), false);
  assertEquals(rendered.includes("draftId"), false);
  assertEquals(rendered.includes('"phase":"delta"'), false);
});

Deno.test("portable CLI renders reasoning and answer streams separately", async () => {
  const answers = ["work it out", "/exit"];
  const output: string[] = [];
  const io: InteractiveCliIo = Object.freeze({
    question: () => Promise.resolve(answers.shift() ?? "/exit"),
    write: (value) => output.push(value),
    close: () => undefined,
  });
  const outputs = [
    streamedText("reasoning", "reasoning-a", ["Inspect ", "the facts."]),
    streamedText("content", "content-a", ["Final ", "answer."]),
  ];
  const handle = startInteractiveCli({
    io,
    scope: {
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["agent-a"],
    },
    inspect: () => ({
      agents: [{ id: "agent-a", name: "Northstar" }],
      tools: [],
      skills: [],
    }),
    application: Object.freeze({
      namespace: "tenant-a",
      send() {
        return Promise.resolve({
          eventId: "event-a",
          correlationId: "correlation-a",
          outputs: new ReadableStream<ApplicationOutput>({
            start(controller) {
              for (const stream of outputs) controller.enqueue(stream);
              controller.close();
            },
          }),
          done: Promise.resolve(),
          cancel: () => Promise.resolve(),
        });
      },
    }),
  });

  await handle.closed;
  const rendered = stripCliFormatting(output.join(""));
  assertStringIncludes(
    rendered,
    "Northstar thinking> Inspect the facts.\nNorthstar> Final answer.",
  );
  assertEquals(rendered.includes("the facts.Final answer."), false);
});

Deno.test("portable CLI uses Core stream agents and renders fragmented Ask drafts safely", async () => {
  const answers = ["coordinate the research", "/exit"];
  const output: string[] = [];
  const io: InteractiveCliIo = Object.freeze({
    question: () => Promise.resolve(answers.shift() ?? "/exit"),
    write: (value) => output.push(value),
    close: () => undefined,
  });
  const coordinator = { id: "coordinator", name: "Coordinator" };
  const researcher = { id: "researcher", name: "Researcher" };
  const askFrames = [{
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 0,
    toolName: "ask",
    phase: "start",
    delta:
      '{"name":"ask","arguments":{"target":"Researcher","message":"Find \\uD83D',
  }, {
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 1,
    toolName: "ask",
    phase: "delta",
    delta: "\\uDE80 launch options",
  }, {
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 2,
    toolName: "ask",
    phase: "delta",
    delta: '"}}',
  }, {
    providerAttemptId: "attempt-a",
    draftId: "attempt-a:0",
    callIndex: 0,
    sequence: 3,
    toolName: "ask",
    phase: "complete",
    delta: "",
    toolCallId: "call-a",
  }];
  const askNdjson = askFrames.map((frame) => JSON.stringify(frame) + "\n")
    .join("");
  const outputs = [
    streamedText(
      "reasoning",
      "coordinator-reasoning",
      ["Delegate this."],
      coordinator,
    ),
    streamedToolCalls([
      askNdjson.slice(0, 37),
      askNdjson.slice(37, 218),
      askNdjson.slice(218),
    ], coordinator),
    streamedText(
      "content",
      "researcher-answer",
      ["Here are the options."],
      researcher,
    ),
    streamedText(
      "content",
      "coordinator-answer",
      ["I recommend option one."],
      coordinator,
    ),
  ];
  const handle = startInteractiveCli({
    io,
    scope: {
      thread: "thread-a",
      participant: "user-a",
      recipientIds: ["fallback-agent"],
    },
    inspect: () => ({
      agents: [{ id: "fallback-agent", name: "Fallback" }],
      tools: [],
      skills: [],
    }),
    application: Object.freeze({
      namespace: "tenant-a",
      send() {
        return Promise.resolve({
          eventId: "event-a",
          correlationId: "correlation-a",
          outputs: new ReadableStream<ApplicationOutput>({
            start(controller) {
              for (const stream of outputs) controller.enqueue(stream);
              controller.close();
            },
          }),
          done: Promise.resolve(),
          cancel: () => Promise.resolve(),
        });
      },
    }),
  });

  await handle.closed;
  const rendered = stripCliFormatting(output.join(""));
  assertStringIncludes(rendered, "Coordinator thinking> Delegate this.");
  assertStringIncludes(
    rendered,
    "Coordinator → @Researcher> Find 🚀 launch options",
  );
  assertStringIncludes(rendered, "Researcher> Here are the options.");
  assertStringIncludes(rendered, "Coordinator> I recommend option one.");
  assertEquals(rendered.includes("Fallback>"), false);
  assertEquals(rendered.includes("\\uD83D"), false);
  assertEquals(rendered.split("🚀").length - 1, 1);
});

Deno.test("portable CLI is factory-first and imports no host terminal API", async () => {
  const source = await Deno.readTextFile(new URL("index.ts", import.meta.url));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
  assert(!/from\s+["']node:|\bDeno\.|\bBun\.|\bprocess\./.test(source));
  assert(!/attachments|performRun|RunInput/.test(source));
  assert(/application\.send\(message/.test(source));
});
