import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  filterTaggedControlTokensStreaming,
  formatMessages,
  getLocalStopSequences,
  parseToolCallsFromResponse,
  parseXmlInvokeToolCalls,
  processStream,
  resolveProviderStopSequences,
  responseHasToolIntent,
  sanitizeUserFacingText,
} from "./utils.ts";

Deno.test("formatMessages limits non-system history using estimated input tokens", () => {
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefgh" }, // 2 tokens
      { role: "user", content: "ijklmnop" }, // 2 tokens
    ],
    config: {
      limitEstimatedInputTokens: 4,
    },
  });

  assertEquals(
    formatted.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [
      { role: "assistant", content: "abcdefgh" },
      { role: "user", content: "ijklmnop" },
    ],
  );
});

Deno.test("formatMessages preserves the system prompt outside the estimated input history budget", () => {
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefgh" }, // 2 tokens
    ],
    instructions: "system", // 2 tokens
    config: {
      limitEstimatedInputTokens: 4,
    },
  });

  assertEquals(
    formatted.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [
      { role: "system", content: "system" },
      { role: "assistant", content: "abcdefgh" },
    ],
  );
});

Deno.test("formatMessages trims the oldest included text message to fit the remaining estimated budget", () => {
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "12345678" }, // 2 tokens
      { role: "assistant", content: "abcdefghijkl" }, // 3 tokens
    ],
    config: {
      limitEstimatedInputTokens: 4,
    },
  });

  assertEquals(
    formatted.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    [
      { role: "user", content: "5678" },
      { role: "assistant", content: "abcdefghijkl" },
    ],
  );
});

Deno.test("formatMessages preserves inline data URL media under estimated input limits", () => {
  const dataUrl = `data:image/png;base64,${"a".repeat(8000)}`;
  const formatted = formatMessages({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Please describe this image." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
    config: {
      limitEstimatedInputTokens: 20,
    },
  });

  assertEquals(formatted.length, 1);
  assertEquals(formatted[0]?.role, "user");
  assertEquals(Array.isArray(formatted[0]?.content), true);
  const parts = formatted[0]?.content as Array<Record<string, unknown>>;
  assertEquals(
    (parts[1] as { image_url?: { url?: string } })?.image_url?.url,
    dataUrl,
  );
});

Deno.test("formatMessages preserves inline audio base64 under estimated input limits", () => {
  const audio = "b".repeat(8000);
  const formatted = formatMessages({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Please transcribe this audio." },
          { type: "input_audio", input_audio: { data: audio, format: "wav" } },
        ],
      },
    ],
    config: {
      limitEstimatedInputTokens: 20,
    },
  });

  assertEquals(formatted.length, 1);
  assertEquals(formatted[0]?.role, "user");
  assertEquals(Array.isArray(formatted[0]?.content), true);
  const parts = formatted[0]?.content as Array<Record<string, unknown>>;
  assertEquals(
    (parts[1] as { input_audio?: { data?: string } })?.input_audio?.data,
    audio,
  );
});

Deno.test("getLocalStopSequences stops both tool results tag forms", () => {
  assertEquals(
    getLocalStopSequences(),
    ["<tool_results>", "</tool_results>"],
  );
});

Deno.test("resolveProviderStopSequences prefers runtime-resolved native list", () => {
  assertEquals(
    resolveProviderStopSequences({
      nativeStopSequences: ["STOP", "<tool_results>"],
      stop: "IGNORED",
    }),
    ["STOP", "<tool_results>"],
  );
});

Deno.test("resolveProviderStopSequences merges and dedupes stop/stopSequences fallback", () => {
  assertEquals(
    resolveProviderStopSequences({
      stopSequences: ["STOP", "HALT"],
      stop: ["HALT", "END"],
    }),
    ["STOP", "HALT", "END"],
  );
});

Deno.test("resolveProviderStopSequences caps to maxCount keeping order", () => {
  assertEquals(
    resolveProviderStopSequences(
      { nativeStopSequences: ["a", "b", "c", "d", "e", "f"] },
      { maxCount: 5 },
    ),
    ["a", "b", "c", "d", "e"],
  );
});

Deno.test("resolveProviderStopSequences returns undefined when empty", () => {
  assertEquals(resolveProviderStopSequences({}), undefined);
});

Deno.test("parseToolCallsFromResponse strips incomplete tool calls after local stop", () => {
  const parsed = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"saveThreadContext","arguments":{"threadData":{"step":"Direção Criativa"}}}\n',
  );

  assertEquals(parsed.cleanResponse, "");
  assertEquals(parsed.toolCalls.length, 1);
  assertEquals(parsed.toolCalls[0].tool.id, "saveThreadContext");
  assertEquals(
    JSON.parse(parsed.toolCalls[0].args as string),
    { threadData: { step: "Direção Criativa" } },
  );
});

Deno.test("parseToolCallsFromResponse strips unrecoverable partial tool calls", () => {
  const parsed = parseToolCallsFromResponse(
    'I will check that.\n<tool_calls>\n{"name":"sandbox_session","arguments":{',
  );

  assertEquals(parsed.cleanResponse, "I will check that.\n");
  assertEquals(parsed.toolCalls.length, 0);
});

Deno.test("parseToolCallsFromResponse recovers the Anthropic/MiniMax <invoke> XML dialect", () => {
  const response =
    'Sure.\n<minimax:tool_call>\n<invoke name="get_weather">\n<parameter name="location">San Francisco</parameter>\n<parameter name="opts">{"unit":"celsius","tags":["a","b"]}</parameter>\n</invoke>\n</minimax:tool_call>';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.toolCalls.length, 1);
  assertEquals(parsed.toolCalls[0].tool.id, "get_weather");
  assertEquals(
    JSON.parse(parsed.toolCalls[0].args as string),
    {
      location: "San Francisco",
      opts: { unit: "celsius", tags: ["a", "b"] },
    },
  );
  assertEquals(parsed.cleanResponse, "Sure.");
});

Deno.test("parseToolCallsFromResponse gates dialect recovery on known tool names", () => {
  const response =
    '<invoke name="unknown_tool"><parameter name="x">1</parameter></invoke>';

  assertEquals(
    parseToolCallsFromResponse(response, ["known_tool"]).toolCalls.length,
    0,
  );
  assertEquals(
    parseToolCallsFromResponse(response, ["unknown_tool"]).toolCalls.length,
    1,
  );
});

Deno.test("parseToolCallsFromResponse leaves an argument-less invoke unparsed", () => {
  const parsed = parseToolCallsFromResponse(
    '<invoke name="known"></invoke>',
    ["known"],
  );
  assertEquals(parsed.toolCalls.length, 0);
});

Deno.test("parseXmlInvokeToolCalls handles multiple invocations", () => {
  const calls = parseXmlInvokeToolCalls(
    '<invoke name="a"><parameter name="x">1</parameter></invoke>' +
      '<invoke name="b"><parameter name="y">two</parameter></invoke>',
  );
  assertEquals(calls.map((c) => c.tool.id), ["a", "b"]);
  assertEquals(JSON.parse(calls[0].args as string), { x: 1 });
  assertEquals(JSON.parse(calls[1].args as string), { y: "two" });
});

Deno.test("responseHasToolIntent detects canonical and gated dialect markers", () => {
  assertEquals(responseHasToolIntent("text <tool_calls> garbage", []), true);
  assertEquals(
    responseHasToolIntent('<invoke name="sandbox_session">', [
      "sandbox_session",
    ]),
    true,
  );
  assertEquals(
    responseHasToolIntent('<invoke name="sandbox_session">', []),
    false,
  );
  assertEquals(
    responseHasToolIntent("just a normal answer", ["sandbox_session"]),
    false,
  );
});

Deno.test("sanitizeUserFacingText strips leaked tool-call protocol markup", () => {
  const leak =
    'I have the abstract.\n]<]minimax[>[<tool_call>\n<invoke name="sandbox_session">]<]minimax[>[<actions>]<]minimax[>[<cmd>ls</cmd>]<]minimax[>[</tool_call>';

  const clean = sanitizeUserFacingText(leak);

  assertEquals(clean.includes("]<]minimax[>["), false);
  assertEquals(clean.includes("<invoke"), false);
  assertEquals(clean.includes("<tool_call>"), false);
  assertEquals(clean, "I have the abstract.");
});

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

Deno.test("formatMessages canonicalizes structured assistant tool calls over pre-rendered blocks", () => {
  const formatted = formatMessages({
    messages: [{
      role: "assistant",
      content:
        'Before\n<tool_calls>\n{"name":"old_tool","arguments":{}}\n</tool_calls>\nAfter',
      toolCalls: [{
        id: "call_1",
        tool: { id: "new_tool" },
        args: JSON.stringify({ ok: true }),
      }],
    }],
  });

  assertEquals(formatted.length, 1);
  assertEquals(formatted[0]?.role, "assistant");
  const wire = formatted[0]?.content as string;
  assertEquals((wire.match(/<tool_calls>/g) ?? []).length, 1);
  assertEquals(wire.includes("new_tool"), true);
  assertEquals(wire.includes("old_tool"), false);
  assertEquals(wire.includes("Before"), true);
  assertEquals(wire.includes("After"), true);
});

Deno.test("formatMessages canonicalizes structured tool results over pre-rendered blocks", () => {
  const formatted = formatMessages({
    messages: [{
      role: "tool",
      content:
        '<tool_results>\n{"name":"old_tool","output":"old"}\n</tool_results>\nraw duplicate',
      toolCalls: [{
        id: "call_1",
        tool: { id: "new_tool" },
        args: "{}",
        output: { ok: true },
        status: "completed",
      }],
    }],
  });

  assertEquals(formatted.length, 2);
  assertEquals(formatted[0]?.role, "assistant");
  assertEquals(formatted[1]?.role, "user");
  const wire = formatted[0]?.content as string;
  assertEquals((wire.match(/<tool_results>/g) ?? []).length, 1);
  assertEquals(wire.includes("new_tool"), true);
  assertEquals(wire.includes("old_tool"), false);
  assertEquals(wire.includes("raw duplicate"), false);
});

Deno.test("formatMessages counts structured tool result output toward input limit", () => {
  const hugeBody = "x".repeat(8000);
  const formatted = formatMessages({
    messages: [
      { role: "user", content: "first" },
      {
        role: "tool",
        content: "",
        toolCalls: [{
          id: "call_1",
          tool: { id: "http_request" },
          args: "{}",
          output: { body: hugeBody },
        }],
      },
    ],
    config: {
      limitEstimatedInputTokens: 500,
    },
  });

  const assistantTurns = formatted.filter((m) => m.role === "assistant");
  assertEquals(assistantTurns.length >= 1, true);
  const toolWire = assistantTurns[assistantTurns.length - 1];
  assertEquals(typeof toolWire.content, "string");
  const wire = toolWire.content as string;
  // Budget is 500 est. tokens → ~2000 chars; tail-slice may omit the opening
  // `<tool_results>` tag but must not retain the full tool JSON.
  assertEquals(wire.length <= 2100, true);
  assertEquals(wire.includes(hugeBody), false);
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
});
