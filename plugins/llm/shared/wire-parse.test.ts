import { assertEquals } from "@std/assert";
import { buildToolCallsBlock } from "./wire-format.ts";
import {
  parseToolCallsFromResponse,
  responseHasMalformedToolCallIntent,
  responseHasOrphanedToolResult,
  responseHasReasoningMarkup,
  responseHasToolIntent,
  sanitizeUserFacingText,
} from "./wire-parse.ts";

Deno.test("parseToolCallsFromResponse rejects incomplete canonical tool calls", () => {
  const parsed = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"saveThreadContext","arguments":{"threadData":{"step":"Direção Criativa"}}}\n',
  );

  assertEquals(parsed.cleanResponse, "");
  assertEquals(parsed.toolCalls.length, 0);
});

Deno.test("parseToolCallsFromResponse closes a complete canonical response tail when enabled", () => {
  const parsed = parseToolCallsFromResponse(
    'I will ask West.\n<tool_calls>\n{"name":"ask_in_thread","arguments":{"target":"west","message":"Review this."},"tool_call_id":"call-1"}',
    ["ask_in_thread"],
    { recoverCompleteUnclosed: true },
  );

  assertEquals(parsed.cleanResponse, "I will ask West.\n");
  assertEquals(parsed.toolCalls.length, 1);
  assertEquals(parsed.toolCalls[0].id === "call-1", false);
  assertEquals(parsed.toolCalls[0].tool.id, "ask_in_thread");
  assertEquals(
    JSON.parse(parsed.toolCalls[0].args),
    { target: "west", message: "Review this." },
  );
});

Deno.test("parseToolCallsFromResponse does not close partial or unknown response tails", () => {
  const partial = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"ask_in_thread","arguments":{',
    ["ask_in_thread"],
    { recoverCompleteUnclosed: true },
  );
  const unknown = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"unknown","arguments":{}}',
    ["ask_in_thread"],
    { recoverCompleteUnclosed: true },
  );
  const trailingText = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"ask_in_thread","arguments":{}}\nmore text',
    ["ask_in_thread"],
    { recoverCompleteUnclosed: true },
  );

  assertEquals(partial.toolCalls.length, 0);
  assertEquals(unknown.toolCalls.length, 0);
  assertEquals(trailingText.toolCalls.length, 0);
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
  assertEquals(
    parseToolCallsFromResponse(
      '<tool_calls>\n{"name":"known","arguments":{},"tool_plan_id":true}\n</tool_calls>',
      ["known"],
    ).toolCalls.length,
    0,
  );
  for (const attribute of ["batch_id", "batch_size", "batch_index"]) {
    assertEquals(
      parseToolCallsFromResponse(
        `<tool_calls>\n{"name":"known","arguments":{},"${attribute}":"retired"}\n</tool_calls>`,
        ["known"],
      ).toolCalls.length,
      0,
    );
  }
});

Deno.test("parseToolCallsFromResponse preserves JSON-line provider order", () => {
  const response =
    '<tool_calls>\n{"name":"extract","arguments":{"source":"crm"}}\n{"name":"analyze","arguments":{"mode":"deep"}}\n{"name":"save","arguments":{"notify":true}}\n</tool_calls>';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.toolCalls.map((call) => call.tool.id), [
    "extract",
    "analyze",
    "save",
  ]);
  assertEquals(parsed.toolCalls.map((call) => JSON.parse(call.args)), [
    { source: "crm" },
    { mode: "deep" },
    { notify: true },
  ]);
});

Deno.test("parseToolCallsFromResponse preserves parallel branches and sequential jq pipelines", () => {
  const parsed = parseToolCallsFromResponse(
    '<tool_calls>\n{"name":"extract","arguments":{}} | {"jq":".items | map({id})"} | {"name":"save","arguments":{"notify":true}}\n{"name":"independent","arguments":{}}\n</tool_calls>',
  );

  assertEquals(parsed.toolCalls.map((call) => call.tool.id), [
    "extract",
    "independent",
  ]);
  assertEquals(
    parsed.toolCalls[0].pipeline?.stages.map((stage) => stage.type),
    [
      "tool",
      "jq",
      "tool",
    ],
  );
  assertEquals(parsed.toolCalls[0].pipeline?.stages[1], {
    type: "jq",
    filter: ".items | map({id})",
  });
  const rehydrated = buildToolCallsBlock(parsed.toolCalls);
  assertEquals(rehydrated.includes(" | "), true);
  assertEquals(parseToolCallsFromResponse(rehydrated).toolCalls.length, 2);
  assertEquals(
    parseToolCallsFromResponse(
      '<tool_calls>\n{"jq":"."} | {"name":"save","arguments":{}}\n</tool_calls>',
    ).toolCalls.length,
    0,
  );
});

Deno.test("parseToolCallsFromResponse closes truncated JSON-line containers", () => {
  const response =
    '<tool_calls>\n{"name":"first","arguments":{"actions":[{"x":1}]}\n{"name":"second","arguments":{"x":2}}\n</tool_calls>';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.toolCalls.map((call) => call.tool.id), [
    "first",
    "second",
  ]);
  assertEquals(JSON.parse(parsed.toolCalls[0].args), {
    actions: [{ x: 1 }],
  });
});

Deno.test("parseToolCallsFromResponse does not repair truncated strings", () => {
  const response =
    '<tool_calls>\n{"name":"first","arguments":{"value":"unfinished}}\n{"name":"second","arguments":{"x":2}}\n</tool_calls>';

  assertEquals(parseToolCallsFromResponse(response).toolCalls.length, 0);
});

Deno.test("parseToolCallsFromResponse replaces duplicate model call ids with framework ids", () => {
  const response =
    'I will do it.<tool_calls>\n{"name":"kanban","arguments":{"action":"move_card","stage":"done"},"tool_call_id":"call-1"}\n{"name":"update_user_memory","arguments":{"content":"context","category":"context"},"tool_call_id":"call-1"}\n</tool_calls>';

  const parsed = parseToolCallsFromResponse(response);

  assertEquals(parsed.cleanResponse, "I will do it.");
  assertEquals(parsed.toolCalls.length, 2);
  assertEquals(parsed.toolCalls[0].id === "call-1", false);
  assertEquals(parsed.toolCalls[1].id === "call-1", false);
  assertEquals(parsed.toolCalls[0].id === parsed.toolCalls[1].id, false);
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
  assertEquals(parsed.toolCalls[0].id === "call-1", false);
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

Deno.test("responseHasOrphanedToolResult detects production-shaped tagless result tails", () => {
  const leak =
    '"}]}],"success":true,"stoppedEarly":false,"sessionSummary":{"status":"idle"},"tool_call_id":"verify_live_preview","status":"completed"}';

  assertEquals(responseHasOrphanedToolResult(leak), true);
  assertEquals(
    responseHasOrphanedToolResult(
      '{"tool_call_id":"example","status":"completed"}',
    ),
    false,
  );
  assertEquals(
    responseHasOrphanedToolResult(
      'The operation succeeded with status "completed".',
    ),
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

Deno.test("sanitizeUserFacingText strips leaked message timestamps without truncating later output", () => {
  const clean = sanitizeUserFacingText(
    "Before\n<message_timestamp>2026-07-31T21:19:51.611Z</message_timestamp>\nAfter",
  );

  assertEquals(clean, "Before\n\nAfter");
  assertEquals(
    sanitizeUserFacingText("Before <message_timestamp/> After"),
    "Before  After",
  );
});
