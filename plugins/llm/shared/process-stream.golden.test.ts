/**
 * Pins what `processStream` emits and returns for representative provider
 * streams, including chunk boundaries, local stops and the post-stop drain.
 */
import { assertEquals, assertRejects } from "@std/assert";
import { processStream } from "./stream.ts";
import type { ProcessStreamOptions, ProviderConfig } from "./types.ts";

type Event = {
  text?: string;
  reasoning?: string;
  usage?: number;
  finish?: string;
  native?: string;
};

function streamOf(chunks: readonly string[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const sse = (event: Event) => `data: ${JSON.stringify(event)}\n`;

const extract = (data: Event) => {
  const parts = [
    ...(data.reasoning ? [{ text: data.reasoning, isReasoning: true }] : []),
    ...(data.text !== undefined ? [{ text: data.text }] : []),
  ];
  return parts.length ? parts : null;
};

const options = (extra: ProcessStreamOptions = {}): ProcessStreamOptions => ({
  extractUsage: (data: Event) =>
    data.usage === undefined ? null : { outputTokens: data.usage },
  extractFinishReason: (data: Event) =>
    (data.finish ?? null) as ReturnType<
      NonNullable<ProcessStreamOptions["extractFinishReason"]>
    >,
  extractNativeReasoning: (data: Event) =>
    data.native ? [{ block: data.native }] : null,
  ...extra,
});

async function run(
  chunks: readonly string[],
  extra: ProcessStreamOptions = {},
) {
  const stream = streamOf(chunks);
  const emitted: string[] = [];
  const result = await processStream(
    stream.getReader(),
    (chunk, meta) => emitted.push(meta?.isReasoning ? `think:${chunk}` : chunk),
    extract,
    options(extra),
  );
  const { usageFinalized, nativeReasoningFinalized, ...rest } = result;
  const finalized = usageFinalized ? await usageFinalized : undefined;
  const nativeFinal = nativeReasoningFinalized
    ? await nativeReasoningFinalized
    : undefined;
  return {
    emitted,
    result: rest,
    ...(usageFinalized ? { finalized } : {}),
    ...(nativeReasoningFinalized ? { nativeFinal } : {}),
    locked: stream.locked,
  };
}

Deno.test("golden stream: SSE across chunk boundaries with hidden tool calls", async () => {
  const body = [
    sse({ reasoning: "plan " }),
    sse({ text: "Hello " }),
    sse({ text: '<tool_calls>\n{"name":"x"}\n</tool_calls>' }),
    sse({ text: " world", usage: 3 }),
    `data: ${JSON.stringify({ usage: 5, finish: "stop", native: "n1" })}`,
  ].join("");
  assertEquals(
    await run([body.slice(0, 17), body.slice(17, 60), body.slice(60)]),
    {
      emitted: ["think:plan ", "Hello ", " world"],
      result: {
        content: 'Hello <tool_calls>\n{"name":"x"}\n</tool_calls> world',
        reasoning: "plan ",
        usage: {
          inputTokens: undefined,
          outputTokens: 5,
          reasoningTokens: undefined,
          cacheReadInputTokens: undefined,
          cacheCreationInputTokens: undefined,
          totalTokens: undefined,
          rawUsage: null,
        },
        nativeReasoning: [{ block: "n1" }],
        finishReason: "stop",
        stoppedByLocalStop: false,
      },
      locked: false,
    },
  );
});

Deno.test("golden stream: JSONL skips blank and invalid lines and post-processes", async () => {
  assertEquals(
    await run(
      [
        `${JSON.stringify({ text: "a" })}\n\nnot json\n`,
        `${JSON.stringify({ text: "b", reasoning: "r" })}\n`,
      ],
      {
        format: "jsonl",
        postProcess: (raw) => raw.toUpperCase(),
        config: { outputReasoning: false } as ProviderConfig,
      },
    ),
    {
      emitted: ["a", "b"],
      result: {
        content: "AB",
        reasoning: "r",
        finishReason: null,
        stoppedByLocalStop: false,
      },
      locked: false,
    },
  );
});

Deno.test("golden stream: local stop without drain ignores the rest of the chunk", async () => {
  const stops: string[] = [];
  assertEquals(
    await run(
      [
        sse({ text: "keep <tool_" }) + sse({ text: "results> drop" }) +
        sse({ usage: 9 }),
      ],
      {
        localStopSequences: ["<tool_results>"],
        onLocalStop: (stop) => stops.push(stop),
      },
    ),
    {
      emitted: ["keep "],
      result: {
        content: "keep ",
        reasoning: "",
        finishReason: null,
        stoppedByLocalStop: true,
        localStopReason: "local_stop_sequence",
        localStopSequence: "<tool_results>",
      },
      locked: false,
    },
  );
  assertEquals(stops, ["<tool_results>"]);
});

Deno.test("golden stream: drain finishes an unterminated trailing line after a stop", async () => {
  assertEquals(
    await run(
      [
        sse({ text: "one " }) +
        `data: ${JSON.stringify({ text: "two STOP three" })}\n` +
        `data: ${JSON.stringify({ usage: 4, finish: "length", native: "n2" })}`,
      ],
      { localStopSequences: ["STOP"], continueAfterLocalStop: true },
    ),
    {
      emitted: ["one ", "two "],
      result: {
        content: "one two ",
        reasoning: "",
        finishReason: null,
        stoppedByLocalStop: true,
        localStopReason: "local_stop_sequence",
        localStopSequence: "STOP",
      },
      finalized: {
        usage: {
          inputTokens: undefined,
          outputTokens: 4,
          reasoningTokens: undefined,
          cacheReadInputTokens: undefined,
          cacheCreationInputTokens: undefined,
          totalTokens: undefined,
          rawUsage: null,
        },
        finishReason: "length",
      },
      nativeFinal: [{ block: "n2" }],
      locked: false,
    },
  );
});

Deno.test("golden stream: drain reads later chunks; same-chunk usage is already in the result", async () => {
  assertEquals(
    await run(
      [
        sse({ text: "go STOP" }) + sse({ usage: 1 }),
        sse({ text: "ignored", usage: 2 }),
        sse({ finish: "stop" }),
      ],
      { localStopSequences: ["STOP"], continueAfterLocalStop: true },
    ),
    {
      emitted: ["go "],
      result: {
        content: "go ",
        reasoning: "",
        usage: {
          inputTokens: undefined,
          outputTokens: 1,
          reasoningTokens: undefined,
          cacheReadInputTokens: undefined,
          cacheCreationInputTokens: undefined,
          totalTokens: undefined,
          rawUsage: null,
        },
        finishReason: null,
        stoppedByLocalStop: true,
        localStopReason: "local_stop_sequence",
        localStopSequence: "STOP",
      },
      finalized: {
        usage: {
          inputTokens: undefined,
          outputTokens: 2,
          reasoningTokens: undefined,
          cacheReadInputTokens: undefined,
          cacheCreationInputTokens: undefined,
          totalTokens: undefined,
          rawUsage: null,
        },
        finishReason: "stop",
      },
      nativeFinal: undefined,
      locked: false,
    },
  );
});

Deno.test("golden stream: a held stop prefix is flushed when the stream ends", async () => {
  assertEquals(
    await run([sse({ text: "almost ST" }), sse({ text: "O" })], {
      localStopSequences: ["STOP"],
    }),
    {
      emitted: ["almost ", "STO"],
      result: {
        content: "almost STO",
        reasoning: "",
        finishReason: null,
        stoppedByLocalStop: false,
      },
      locked: false,
    },
  );
});

Deno.test("golden stream: default stop sequences come from the provider config", async () => {
  const { result } = await run(
    [sse({ text: "answer<tool_results>\nleak" })],
    { config: {} as ProviderConfig },
  );
  assertEquals(result.content, "answer");
  assertEquals(result.localStopSequence, "<tool_results");
});

Deno.test("golden stream: reader errors propagate and release the reader", async () => {
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  await assertRejects(
    () => processStream(stream.getReader(), () => {}, extract),
    Error,
    "aborted",
  );
  assertEquals(stream.locked, false);
});
