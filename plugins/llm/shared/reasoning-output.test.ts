import { assertEquals } from "@std/assert";
import {
  createReasoningOutputReader,
  extractReasoningOutput,
} from "./reasoning-output.ts";
import { sanitizeUserFacingText } from "./wire-parse.ts";

Deno.test("one output reader extracts provider markup at every chunk boundary", () => {
  for (const tag of ["think", "thought", "thinking", "reasoning", "mm:think"]) {
    const text = `Before <${tag}>private\nreasoning</${tag}> after`;
    for (let split = 0; split <= text.length; split++) {
      const reader = createReasoningOutputReader();
      const first = reader.write(text.slice(0, split));
      const last = reader.write(text.slice(split), true);
      assertEquals(first.visible + last.visible, "Before  after");
      assertEquals(first.reasoning + last.reasoning, "private\nreasoning");
    }
  }
});

Deno.test("output extraction preserves quoted markup, fenced and inline code", () => {
  const literal = [
    'Use `<think>example</think>` or "<thought>quoted</thought>".',
    "```xml",
    "<think>code</think>",
    "```",
    "> <reasoning>quoted line</reasoning>",
    "~~~html",
    "<thinking>other code</thinking>",
    "~~~",
  ].join("\n");
  const text = literal + "\n<think>hidden</think>Answer";
  const expected = literal + "\nAnswer";
  assertEquals(extractReasoningOutput(text), {
    visible: expected,
    reasoning: "hidden",
  });
  assertEquals(sanitizeUserFacingText(text), expected);
  const reader = createReasoningOutputReader();
  let visible = "";
  let reasoning = "";
  for (const char of text) {
    const part = reader.write(char);
    visible += part.visible;
    reasoning += part.reasoning;
  }
  const last = reader.write("", true);
  assertEquals(visible + last.visible, expected);
  assertEquals(reasoning + last.reasoning, "hidden");
});

Deno.test("output extraction preserves tool JSON string values and trailing backticks", () => {
  for (
    const text of [
      '{"name":"echo","arguments":{"text":"<think>literal</think>"}}',
      "`<think>literal</think>`",
    ]
  ) {
    const reader = createReasoningOutputReader();
    let visible = "";
    for (const char of text) visible += reader.write(char).visible;
    visible += reader.write("", true).visible;
    assertEquals(visible, text);
  }
});

Deno.test("unclosed reasoning is diagnostic output and not visible content", () => {
  assertEquals(extractReasoningOutput("Answer<think>unfinished"), {
    visible: "Answer",
    reasoning: "unfinished",
  });
  assertEquals(extractReasoningOutput("Answer</think>"), {
    visible: "Answer",
    reasoning: "",
  });
});

Deno.test("long split headers and code delimiters are consumed incrementally", () => {
  const reader = createReasoningOutputReader();
  assertEquals(reader.write('<think data="').visible, "");
  for (let i = 0; i < 500; i++) {
    assertEquals(reader.write("attribute ".repeat(100)).visible, "");
  }
  assertEquals(reader.write('">private</think>Answer', true), {
    visible: "Answer",
    reasoning: "private",
  });
  const code = createReasoningOutputReader();
  for (let i = 0; i < 100; i++) {
    assertEquals(code.write("`".repeat(100)).visible, "`".repeat(100));
  }
  assertEquals(code.write("\n<think>literal</think>\n", true), {
    visible: "\n<think>literal</think>\n",
    reasoning: "",
  });
});
