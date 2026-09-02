import { assert, assertEquals } from "@std/assert";
import AjvModule from "ajv";
import { createInspectMemoryTool } from "../../resources/inspect-memory-tool/index.ts";
import { createInspectMemoryAction } from "./index.ts";

Deno.test("inspect action publishes a closed output schema through its Tool", () => {
  const action = createInspectMemoryAction();
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
    createInspectMemoryTool(action).outputSchema,
    action.outputSchema,
  );
});
