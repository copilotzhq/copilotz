import { assert, assertEquals } from "@std/assert";
import AjvModule from "ajv";
import { inspectMemoryTool } from "../../resources/tools/inspect-memory/index.ts";
import { inspectMemoryAction } from "./index.ts";

Deno.test("inspect action publishes a closed output schema through its Tool", () => {
  const action = inspectMemoryAction;
  assertEquals(action.id, "copilotz.memory.inspect");
  assert(action.outputSchema);
  assert(
    new AjvModule.default({ allErrors: true, strict: false }).compile(
      action.outputSchema,
    ),
  );
  assertEquals(
    (action.outputSchema as { additionalProperties?: boolean })
      .additionalProperties,
    false,
  );
  assertEquals(
    inspectMemoryTool.outputSchema,
    action.outputSchema,
  );
});
