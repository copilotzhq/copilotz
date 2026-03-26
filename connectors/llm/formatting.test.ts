import { formatMessages } from "./utils.ts";
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
      content: '[Tool Result]: {"sessionId":"abc"}',
      tool_call_id: "tool-1",
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

  assertEquals(formatted.length, 1);
  assertEquals(formatted[0].role, "assistant");
  assertEquals(
    formatted[0].content,
    `<function_calls>
{"name":"startSession","arguments":{},"tool_call_id":"tool-1"}
</function_calls>
Para começarmos, me diga origem e destino.

[Tool Result]: {"sessionId":"abc"}

<function_calls>
{"name":"searchTrips","arguments":{"date":"2026-04-06"},"tool_call_id":"tool-2"}
</function_calls>
Agora confirme a data da viagem.`,
  );
  assertEquals(formatted[0].tool_call_id, undefined);
  assertEquals(formatted[0].toolCalls, undefined);
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
