import {
  filterToolCallTokensStreaming,
  formatMessages,
  parseInternalControlTagsFromResponse,
  withDefaultStopSequences,
} from "./utils.ts";
import { historyGenerator } from "../../event-processors/new_message/generators/history-generator.ts";
import type { ChatMessage } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${
          JSON.stringify(actual)
        }`,
    );
  }
}

Deno.test("formatMessages rewrites tool results to assistant and preserves chronology when merging same-sender assistant history", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      senderId: "mobizap",
      content: "Para começarmos, me diga origem e destino.",
      toolCalls: [
        {
          id: "tool-1",
          tool: { id: "startSession" },
          args: "{}",
        },
      ],
    },
    {
      role: "tool",
      senderId: "mobizap",
      content: '{"sessionId":"abc"}',
      tool_call_id: "tool-1",
      toolCalls: [
        {
          id: "tool-1",
          tool: { id: "startSession" },
          args: "{}",
          output: { sessionId: "abc" },
          status: "completed",
        },
      ],
    },
    {
      role: "assistant",
      senderId: "mobizap",
      content: "Agora confirme a data da viagem.",
      toolCalls: [
        {
          id: "tool-2",
          tool: { id: "searchTrips" },
          args: '{"date":"2026-04-06"}',
        },
      ],
    },
  ];

  const formatted = formatMessages({ messages });

  assertEquals(formatted.length, 2);
  assertEquals(formatted[0].role, "assistant");
  assertEquals(
    formatted[0].content,
    `<function_calls>
{"name":"startSession","arguments":{},"tool_call_id":"tool-1"}
</function_calls>
Para começarmos, me diga origem e destino.

<function_results>
{"name":"startSession","output":{"sessionId":"abc"},"tool_call_id":"tool-1","status":"completed"}
</function_results>

<function_calls>
{"name":"searchTrips","arguments":{"date":"2026-04-06"},"tool_call_id":"tool-2"}
</function_calls>
Agora confirme a data da viagem.`,
  );
  assertEquals(formatted[0].tool_call_id, undefined);
  assertEquals(formatted[0].toolCalls, undefined);
  assertEquals(formatted[1].role, "user");
  assertEquals(
    formatted[1].content,
    "<continue_after_tool_results/>",
  );
});

Deno.test("formatMessages does not merge same-role messages from different senders", () => {
  const messages: ChatMessage[] = [
    { role: "user", senderId: "user-a", content: "Oi" },
    { role: "user", senderId: "user-b", content: "Tudo bem?" },
  ];

  const formatted = formatMessages({ messages });

  assertEquals(formatted.length, 2);
  assertEquals(formatted[0].content, "Oi");
  assertEquals(formatted[1].content, "Tudo bem?");
});

Deno.test("formatMessages merges consecutive user messages from the same sender", () => {
  const messages: ChatMessage[] = [
    { role: "user", senderId: "user-a", content: "Oi" },
    { role: "user", senderId: "user-a", content: "Preciso de ajuda" },
  ];

  const formatted = formatMessages({ messages });

  assertEquals(formatted.length, 1);
  assertEquals(formatted[0].role, "user");
  assertEquals(formatted[0].content, "Oi\n\nPreciso de ajuda");
});

Deno.test("formatMessages does not append a continuation cue when the last message is already user", () => {
  const messages: ChatMessage[] = [
    {
      role: "assistant",
      senderId: "mobizap",
      content: "Tudo certo.",
      toolCalls: [
        {
          id: "tool-1",
          tool: { id: "startSession" },
          args: "{}",
        },
      ],
    },
    {
      role: "tool",
      senderId: "mobizap",
      content: '{"sessionId":"abc"}',
      tool_call_id: "tool-1",
      toolCalls: [
        {
          id: "tool-1",
          tool: { id: "startSession" },
          args: "{}",
          output: { sessionId: "abc" },
          status: "completed",
        },
      ],
    },
    { role: "user", senderId: "user-a", content: "E agora?" },
  ];

  const formatted = formatMessages({ messages });

  assertEquals(formatted.length, 2);
  assertEquals(formatted[1].role, "user");
  assertEquals(formatted[1].content, "E agora?");
});

Deno.test("withDefaultStopSequences appends function_results without dropping caller stops", () => {
  const config = withDefaultStopSequences({
    stop: ["DONE"],
    stopSequences: ["HALT"],
  });

  assertEquals(config.stop, ["HALT", "DONE", "<function_results>"]);
  assertEquals(config.stopSequences, ["HALT", "DONE", "<function_results>"]);
});

Deno.test("parseInternalControlTagsFromResponse strips no_response and continuation cues", () => {
  const parsed = parseInternalControlTagsFromResponse(
    "  <continue_after_tool_results/><no_response/>  ",
  );

  assertEquals(parsed.cleanResponse, "");
  assertEquals(parsed.suppressResponse, true);
});

Deno.test("filterToolCallTokensStreaming strips no_response from streamed tokens", () => {
  const state = { inside: false, pending: "", controlPending: "" };

  const first = filterToolCallTokensStreaming("Ol", state);
  const second = filterToolCallTokensStreaming("a<no_res", state);
  const third = filterToolCallTokensStreaming("ponse/>", state);

  assertEquals(first, "Ol");
  assertEquals(second, "a");
  assertEquals(third, "");
});

Deno.test("historyGenerator exposes structured tool result metadata for formatter blocks", () => {
  const history = historyGenerator(
    [
      {
        senderId: "mobizap",
        senderType: "tool",
        content: '{"sessionId":"abc"}',
        metadata: {
          toolCalls: [
            {
              id: "tool-1",
              tool: { id: "startSession", name: "startSession" },
              args: "{}",
              output: { sessionId: "abc" },
              status: "completed",
            },
          ],
        },
      },
    ] as any,
    { id: "mobizap", name: "mobizap" } as any,
  );

  assertEquals(history.length, 1);
  assertEquals(history[0].role, "tool");
  assertEquals(history[0].content, '{"sessionId":"abc"}');
  assertEquals(history[0].toolCalls, [
    {
      id: "tool-1",
      tool: { id: "startSession" },
      args: "{}",
      output: { sessionId: "abc" },
      status: "completed",
    },
  ]);
});

Deno.test("historyGenerator projects public_result tool outputs for other agents", () => {
  const history = historyGenerator(
    [
      {
        senderId: "planner",
        senderType: "tool",
        content: '{"sessionId":"abc"}',
        metadata: {
          toolCalls: [
            {
              id: "tool-1",
              tool: { id: "startSession", name: "startSession" },
              args: "{}",
              output: { sessionId: "abc", internalCode: "secret" },
              projectedOutput: "Booking session started successfully.",
              visibility: "public_result",
              status: "completed",
            },
          ],
        },
      },
    ] as any,
    { id: "reviewer", name: "reviewer" } as any,
  );

  assertEquals(history.length, 1);
  assertEquals(history[0].role, "tool");
  assertEquals(history[0].toolCalls, [
    {
      id: "tool-1",
      tool: { id: "startSession" },
      args: "{}",
      output: "Booking session started successfully.",
      status: "completed",
    },
  ]);
});

Deno.test("historyGenerator hides requester_only tool outputs from other agents", () => {
  const history = historyGenerator(
    [
      {
        senderId: "planner",
        senderType: "tool",
        content: '{"sessionId":"abc"}',
        metadata: {
          toolCalls: [
            {
              id: "tool-1",
              tool: { id: "startSession", name: "startSession" },
              args: "{}",
              output: { sessionId: "abc" },
              visibility: "requester_only",
              status: "completed",
            },
          ],
        },
      },
    ] as any,
    { id: "reviewer", name: "reviewer" } as any,
  );

  assertEquals(history.length, 0);
});

Deno.test("historyGenerator keeps raw assistant tool calls private to the calling agent", () => {
  const sharedHistory = historyGenerator(
    [
      {
        senderId: "planner",
        senderType: "agent",
        content: "Vou consultar a rota.",
        toolCalls: [
          {
            id: "tool-1",
            tool: { id: "checkRoute", name: "checkRoute" },
            args: '{"origin":"Sao Paulo","destination":"Piracicaba"}',
          },
        ],
      },
    ] as any,
    { id: "reviewer", name: "reviewer" } as any,
  );

  assertEquals(sharedHistory.length, 1);
  assertEquals(sharedHistory[0].role, "user");
  assertEquals(sharedHistory[0].toolCalls, undefined);
});
