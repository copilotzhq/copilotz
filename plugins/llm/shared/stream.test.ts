import { assertEquals } from "@std/assert";
import {
  createCanonicalToolCallDraftTracker,
  filterTaggedControlTokensStreaming,
  processStream,
} from "./stream.ts";

Deno.test("filterTaggedControlTokensStreaming hides native tool dialect and leak tokens", () => {
  const state = {
    activeTag: null as string | null,
    pending: "",
    controlPending: "",
  };
  const out = filterTaggedControlTokensStreaming(
    "Hello ]<]minimax[>[world <minimax:tool_call>secret</minimax:tool_call>!",
    state,
    [],
  );

  assertEquals(out.includes("]<]minimax[>["), false);
  assertEquals(out.includes("secret"), false);
  assertEquals(out.includes("<minimax:tool_call>"), false);
  assertEquals(out.includes("Hello"), true);
  assertEquals(out.includes("world"), true);
});

Deno.test("filterTaggedControlTokensStreaming hides tool blocks split across chunks", () => {
  const state = {
    activeTag: null as string | null,
    pending: "",
    controlPending: "",
  };
  const chunks = [
    "Public ",
    "text<tool_",
    'calls>{"name":"handoff_in_thread"}</tool_',
    "calls> remains visible.",
  ];

  const visible = chunks.map((chunk) =>
    filterTaggedControlTokensStreaming(chunk, state, [])
  ).join("");

  assertEquals(visible, "Public text remains visible.");
  assertEquals(state.activeTag, null);
  assertEquals(state.pending, "");
});

Deno.test("filterTaggedControlTokensStreaming hides leaked message timestamps across chunks", () => {
  const state = {
    activeTag: null as string | null,
    pending: "",
    controlPending: "",
  };
  const chunks = [
    "Before <message_time",
    "stamp>2026-07-31T21:19:51.611Z</message_",
    "timestamp> after",
  ];

  const visible = chunks.map((chunk) =>
    filterTaggedControlTokensStreaming(chunk, state, [])
  ).join("");

  assertEquals(visible, "Before  after");
  assertEquals(state.activeTag, null);
  assertEquals(state.pending, "");
});

Deno.test("filterTaggedControlTokensStreaming preserves output after a self-closing timestamp", () => {
  const state = {
    activeTag: null as string | null,
    pending: "",
    controlPending: "",
  };

  const visible = filterTaggedControlTokensStreaming(
    "Before <message_timestamp/> after",
    state,
    [],
  );

  assertEquals(visible, "Before  after");
  assertEquals(state.activeTag, null);
  assertEquals(state.pending, "");
});

Deno.test("canonical tool draft tracker preserves escaped JSON across chunks", () => {
  const deltas: Array<{
    phase: string;
    delta: string;
    toolCallId?: string;
  }> = [];
  const tracker = createCanonicalToolCallDraftTracker({
    knownToolNames: ["terminal"],
    providerAttemptId: "attempt-1",
    emit: (delta) => deltas.push(delta),
  });
  const line =
    '{"name":"terminal","arguments":{"stdin":"printf \\"a\\\\nb\\""}}';

  tracker.observe("tool_calls", "", "start");
  tracker.observe("tool_calls", line.slice(0, 31), "content");
  tracker.observe("tool_calls", line.slice(31), "content");
  tracker.observe("tool_calls", "", "end");
  tracker.complete([{
    id: "call-1",
    tool: { id: "terminal" },
    args: '{"stdin":"printf \\"a\\\\nb\\""}',
  }]);

  assertEquals(deltas.map((delta) => delta.phase), [
    "start",
    "delta",
    "complete",
  ]);
  assertEquals(
    deltas
      .filter((delta) => delta.phase === "start" || delta.phase === "delta")
      .map((delta) => delta.delta)
      .join(""),
    line,
  );
  assertEquals(deltas.at(-1)?.toolCallId, "call-1");
});

Deno.test("canonical tool draft tracker handles ordered calls and private names", () => {
  const deltas: Array<{
    callIndex: number;
    toolName: string;
    phase: string;
  }> = [];
  const tracker = createCanonicalToolCallDraftTracker({
    knownToolNames: ["search", "terminal"],
    providerAttemptId: "attempt-many",
    emit: (delta) => deltas.push(delta),
  });
  tracker.observe("tool_calls", "", "start");
  tracker.observe(
    "tool_calls",
    [
      '{"name":"unknown","arguments":{}}',
      '{"name":"search","arguments":{"q":"one"}}',
      '{"name":"terminal","arguments":{"stdin":"pwd"}}',
    ].join("\n"),
    "content",
  );
  tracker.observe("tool_calls", "", "end");
  tracker.complete([
    { id: "unknown-id", tool: { id: "unknown" }, args: "{}" },
    { id: "search-id", tool: { id: "search" }, args: '{"q":"one"}' },
    { id: "terminal-id", tool: { id: "terminal" }, args: '{"stdin":"pwd"}' },
  ]);

  assertEquals(
    deltas.filter((delta) => delta.phase === "start").map((delta) => ({
      callIndex: delta.callIndex,
      toolName: delta.toolName,
    })),
    [
      { callIndex: 1, toolName: "search" },
      { callIndex: 2, toolName: "terminal" },
    ],
  );
  assertEquals(
    deltas.filter((delta) => delta.phase === "complete").map((delta) =>
      delta.toolName
    ),
    ["search", "terminal"],
  );
});

Deno.test("canonical tool draft tracker recognizes a top-level name after arguments", () => {
  const deltas: Array<{ phase: string; delta: string }> = [];
  const tracker = createCanonicalToolCallDraftTracker({
    knownToolNames: ["terminal"],
    providerAttemptId: "attempt-key-order",
    emit: (delta) => deltas.push(delta),
  });
  const line =
    '{"arguments":{"stdin":"pwd","nested":{"name":"private"}},"name":"terminal"}';

  tracker.observe("tool_calls", line, "content");
  tracker.complete([{
    id: "call-key-order",
    tool: { id: "terminal" },
    args: '{"stdin":"pwd","nested":{"name":"private"}}',
  }]);

  assertEquals(deltas.map((delta) => delta.phase), ["start", "complete"]);
  assertEquals(deltas[0]?.delta, line);
});

Deno.test("canonical tool draft tracker discards abandoned malformed drafts", () => {
  const phases: string[] = [];
  const tracker = createCanonicalToolCallDraftTracker({
    knownToolNames: ["terminal"],
    providerAttemptId: "attempt-discard",
    emit: (delta) => phases.push(delta.phase),
  });
  tracker.observe(
    "tool_calls",
    '{"name":"terminal","arguments":{"stdin":"unterminated',
    "content",
  );
  tracker.discardAll();

  assertEquals(phases, ["start", "discarded"]);
});

Deno.test("processStream returns on local stop and drains final usage metadata", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `data: ${
            JSON.stringify({ text: "visible<tool_results>ignored" })
          }\n\n`,
        ),
      );
      setTimeout(() => {
        controller.enqueue(encoder.encode(`data: ${
          JSON.stringify({
            usage: {
              input_tokens: 10,
              output_tokens: 3,
              cache_read_input_tokens: 7,
              total_tokens: 13,
            },
            done: true,
          })
        }\n\n`));
        controller.close();
      }, 0);
    },
  });

  const chunks: string[] = [];
  const result = await processStream(
    stream.getReader(),
    (chunk) => chunks.push(chunk),
    (data) => typeof data.text === "string" ? [{ text: data.text }] : null,
    {
      localStopSequences: ["<tool_results>"],
      continueAfterLocalStop: true,
      extractUsage: (data) => {
        const usage = data.usage;
        return usage
          ? {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheReadInputTokens: usage.cache_read_input_tokens,
            totalTokens: usage.total_tokens,
            rawUsage: usage,
          }
          : null;
      },
      extractNativeReasoning: (data) =>
        data.done === true ? [{ signature: "terminal" }] : null,
    },
  );

  assertEquals(result.content, "visible");
  assertEquals(chunks.join(""), "visible");
  assertEquals(result.stoppedByLocalStop, true);
  assertEquals(result.localStopReason, "local_stop_sequence");
  assertEquals(result.localStopSequence, "<tool_results>");
  assertEquals(result.usage, undefined);
  const finalized = await result.usageFinalized;
  assertEquals(finalized?.usage?.inputTokens, 10);
  assertEquals(finalized?.usage?.cacheReadInputTokens, 7);
  assertEquals(finalized?.usage?.totalTokens, 13);
  assertEquals("nativeReasoning" in (finalized ?? {}), false);
  assertEquals(await result.nativeReasoningFinalized, [{
    signature: "terminal",
  }]);
});
