import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  deriveWorkflowId,
  MAX_DERIVED_WORKFLOW_ID_LENGTH,
} from "./workflow-id.ts";

Deno.test("derived workflow IDs preserve safe short readable identities", async () => {
  assertEquals(
    await deriveWorkflowId("tool", "llm-message-user-agent-north", "call-1"),
    "tool:llm-message-user-agent-north:call-1",
  );
});

Deno.test("derived workflow IDs encode tuple delimiters losslessly", async () => {
  const left = await deriveWorkflowId("tool", "a:b", "c");
  const right = await deriveWorkflowId("tool", "a", "b:c");
  const literalEscape = await deriveWorkflowId("tool", "a%003ab", "c");
  const compactMarker = await deriveWorkflowId(
    "tool",
    "#sha256",
    "0123456789abcdef",
  );

  assertEquals(left, "tool:a%003ab:c");
  assertEquals(right, "tool:a:b%003ac");
  assertEquals(literalEscape, "tool:a%0025003ab:c");
  assertEquals(compactMarker, "tool:%0023sha256:0123456789abcdef");
  assert(left !== right);
  assert(left !== literalEscape);
});

Deno.test("derived workflow IDs distinguish every UTF-16 input", async () => {
  assertEquals(
    await deriveWorkflowId("message", "café", "\ud800"),
    "message:caf%00e9:%d800",
  );
  assert(
    await deriveWorkflowId("message", "\ud800") !==
      await deriveWorkflowId("message", "\ud801"),
  );
});

Deno.test("derived workflow IDs compact long ancestry deterministically", async () => {
  const parent = `llm:${"ancestry:".repeat(40)}`;
  const first = await deriveWorkflowId("tool", parent, "call-1");
  const repeated = await deriveWorkflowId("tool", parent, "call-1");
  const distinct = await deriveWorkflowId("tool", parent, "call-2");

  assertEquals(first, repeated);
  assert(first !== distinct);
  assert(first.length <= MAX_DERIVED_WORKFLOW_ID_LENGTH);
  assertMatch(first, /^tool::sha256:[a-f0-9]{64}$/);

  let nested = first;
  for (let index = 0; index < 32; index += 1) {
    nested = await deriveWorkflowId("message", nested, `output-${index}`);
    assert(nested.length <= MAX_DERIVED_WORKFLOW_ID_LENGTH);
  }
});
