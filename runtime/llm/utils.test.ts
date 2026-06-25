import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import {
  detectDegenerateRepetition,
  filterTaggedControlTokensStreaming,
  formatMessages,
  getLocalStopSequences,
  parseToolCallsFromResponse,
  processStream,
  resolveProviderStopSequences,
  responseHasMalformedToolCallIntent,
  responseHasReasoningMarkup,
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

Deno.test("detectDegenerateRepetition catches noisy repeated JSON-ish tail", () => {
  const prefix = "The board updates are complete. ";
  const repeated = Array.from(
    { length: 80 },
    (_, index) => index % 5 === 0 ? '"source": "source": "source"' : '"source"',
  ).join(", ");
  const detected = detectDegenerateRepetition(`${prefix}${repeated}`);

  assertEquals(Boolean(detected), true);
  assertEquals(detected?.reason, "low_entropy_periodic_tail");
  assertEquals(detected && detected.startIndex >= prefix.length, true);
});

Deno.test("detectDegenerateRepetition catches repeated phrases", () => {
  const prefix = "I found the blocker. ";
  const phrase = "the task is blocked because ownership cannot be verified ";
  const detected = detectDegenerateRepetition(prefix + phrase.repeat(14));

  assertEquals(Boolean(detected), true);
  assertEquals(detected?.periodTokens.length, 9);
  assertEquals(detected && detected.startIndex >= prefix.length, true);
});

Deno.test("detectDegenerateRepetition ignores normal repeated domain terms", () => {
  const answer =
    "The blocked cards are blocked for different reasons: the Meta app is not ready, the WABA owner is unclear, and the migration path needs confirmation. Move only the blocked work to the blocked column and leave the remaining todo cards unchanged.";

  assertEquals(detectDegenerateRepetition(answer), null);
});

Deno.test("getLocalStopSequences stops both tool results tag forms", () => {
  assertEquals(
    getLocalStopSequences(),
    [
      "<tool_results",
      "</tool_results>",
      "<continue_after_tool_results",
      "<result",
      "</result>",
      "<tool_result",
      "</tool_result>",
    ],
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

Deno.test("parseToolCallsFromResponse rejects incomplete canonical tool calls", () => {
  const parsed = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"saveThreadContext","arguments":{"threadData":{"step":"Direção Criativa"}}}\n',
  );

  assertEquals(parsed.cleanResponse, "");
  assertEquals(parsed.toolCalls.length, 0);
});

Deno.test("parseToolCallsFromResponse strips unrecoverable partial tool calls", () => {
  const parsed = parseToolCallsFromResponse(
    'I will check that.\n<tool_calls>\n{"name":"sandbox_session","arguments":{',
  );

  assertEquals(parsed.cleanResponse, "I will check that.\n");
  assertEquals(parsed.toolCalls.length, 0);
});

Deno.test("parseToolCallsFromResponse rejects non-canonical XML tool dialect", () => {
  const response =
    'Sure.\n<minimax:tool_call>\n<invoke name="get_weather">\n<parameter name="location">San Francisco</parameter>\n<parameter name="opts">{"unit":"celsius","tags":["a","b"]}</parameter>\n</invoke>\n</minimax:tool_call>';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.toolCalls.length, 0);
  assertEquals(parsed.cleanResponse, response);
});

Deno.test("parseToolCallsFromResponse only accepts strict JSON-lines calls", () => {
  const response =
    '<tool_calls>\n{"name":"known","arguments":{"x":1}}\n</tool_calls>';

  assertEquals(
    parseToolCallsFromResponse(response, ["known"]).toolCalls.length,
    1,
  );
  assertEquals(
    parseToolCallsFromResponse(
      '<tool_calls>\n{"name":"known","arguments":{"x":1},"extra":true}\n</tool_calls>',
      ["known"],
    ).toolCalls.length,
    0,
  );
});

Deno.test("parseToolCallsFromResponse accepts optional tool_call_id after visible punctuation", () => {
  const response =
    'I will do it.<tool_calls>\n{"name":"kanban","arguments":{"action":"move_card","stage":"done"},"tool_call_id":"call-1"}\n{"name":"update_user_memory","arguments":{"content":"context","category":"context"}}\n</tool_calls>';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.cleanResponse, "I will do it.");
  assertEquals(parsed.toolCalls.length, 2);
  assertEquals(parsed.toolCalls[0].id, "call-1");
  assertEquals(parsed.toolCalls[0].tool.id, "kanban");
  assertEquals(
    JSON.parse(parsed.toolCalls[0].args),
    { action: "move_card", stage: "done" },
  );
  assertEquals(parsed.toolCalls[1].tool.id, "update_user_memory");
});

Deno.test("parseToolCallsFromResponse salvages restarted canonical block after malformed prefix", () => {
  const response =
    '<tool_calls>\n{"name":"\n[reasoning truncated: 9497 chars omitted]<tool_calls>\n{"name":"kanban","arguments":{"action":"move_card","stage":"done"},"tool_call_id":"call-1"}\n</tool_calls>\nVisible answer';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.cleanResponse, "Visible answer");
  assertEquals(parsed.toolCalls.length, 1);
  assertEquals(parsed.toolCalls[0].id, "call-1");
  assertEquals(parsed.toolCalls[0].tool.id, "kanban");
  assertEquals(
    JSON.parse(parsed.toolCalls[0].args),
    { action: "move_card", stage: "done" },
  );
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

Deno.test("responseHasMalformedToolCallIntent detects non-canonical tool syntax", () => {
  assertEquals(
    responseHasMalformedToolCallIntent(
      '<invoke name="sandbox_session"><parameter name="actions">[]</parameter></invoke>',
      ["sandbox_session"],
    ),
    true,
  );
  assertEquals(
    responseHasMalformedToolCallIntent(
      '<tool_calls>\n{"name":"sandbox_session","arguments":{}}\n</tool_calls>',
      ["sandbox_session"],
    ),
    false,
  );
  assertEquals(
    responseHasMalformedToolCallIntent('<invoke name="sandbox_session">', []),
    false,
  );
});

Deno.test("responseHasReasoningMarkup detects visible thinking tags", () => {
  assertEquals(
    responseHasReasoningMarkup("answer <think>private</think>"),
    true,
  );
  assertEquals(responseHasReasoningMarkup("answer </mm:think>"), true);
  assertEquals(responseHasReasoningMarkup("plain answer"), false);
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
