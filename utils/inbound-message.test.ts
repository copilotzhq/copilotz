import {
  hasRunInput,
  normalizeInboundRunMessage,
  normalizeInboundToolCalls,
} from "./inbound-message.ts";

function assertEquals<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      message ||
        `Assertion failed.\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`,
    );
  }
}

Deno.test("normalizeInboundToolCalls accepts tool_calls function payloads", () => {
  const toolCalls = normalizeInboundToolCalls({
    content: "",
    sender: { type: "user", name: "User" },
    tool_calls: [{
      id: "call_1",
      function: {
        name: "create_thread",
        arguments: JSON.stringify({ name: "Test" }),
      },
    }],
  });

  assertEquals(toolCalls, [{
    id: "call_1",
    name: "create_thread",
    args: { name: "Test" },
  }]);
});

Deno.test("normalizeInboundToolCalls falls back to metadata.toolCalls", () => {
  const toolCalls = normalizeInboundToolCalls({
    content: "",
    sender: { type: "user", name: "User" },
    metadata: {
      toolCalls: [{
        name: "save_user_context",
        args: JSON.stringify({ section: "profile" }),
      }],
    },
  });

  assertEquals(toolCalls, [{
    id: null,
    name: "save_user_context",
    args: { section: "profile" },
  }]);
});

Deno.test("normalizeInboundRunMessage normalizes tool calls for run()", () => {
  const message = normalizeInboundRunMessage({
    content: "   ",
    sender: { type: "user", name: "User" },
    tool_calls: [{
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "notes.txt" }),
      },
    }],
  });

  assertEquals(message.toolCalls, [{
    id: null,
    name: "write_file",
    args: { path: "notes.txt" },
  }]);
});

Deno.test("hasRunInput allows tool-call-only messages", () => {
  const normalized = normalizeInboundRunMessage({
    content: "   ",
    sender: { type: "user", name: "User" },
    tool_calls: [{
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "notes.txt" }),
      },
    }],
  });

  assertEquals(hasRunInput(normalized), true);
});
