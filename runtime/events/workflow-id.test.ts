import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  deriveWorkflowId,
  MAX_DERIVED_WORKFLOW_ID_LENGTH,
} from "./workflow-id.ts";

Deno.test("derived workflow IDs preserve short readable identities", async () => {
  assertEquals(
    await deriveWorkflowId("tool", "llm:message:user:agent-north", "call-1"),
    "tool:llm:message:user:agent-north:call-1",
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
  assertMatch(first, /^tool:sha256:[a-f0-9]{64}$/);

  let nested = first;
  for (let index = 0; index < 32; index += 1) {
    nested = await deriveWorkflowId("message", nested, `output-${index}`);
    assert(nested.length <= MAX_DERIVED_WORKFLOW_ID_LENGTH);
  }
});
