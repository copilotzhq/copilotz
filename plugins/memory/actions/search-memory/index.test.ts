import { assert, assertEquals } from "@std/assert";
import AjvModule from "ajv";
import { createSearchMemoryTool } from "../../resources/search-memory-tool/index.ts";
import { createSearchMemoryAction } from "./index.ts";

Deno.test("search action publishes a closed output schema through its Tool", () => {
  const action = createSearchMemoryAction();
  assertEquals(action.id, "copilotz.memory.search");
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
    createSearchMemoryTool(action).outputSchema,
    action.outputSchema,
  );
});
