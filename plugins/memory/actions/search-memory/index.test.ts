import { assert, assertEquals } from "@std/assert";
import AjvModule from "ajv";
import { searchMemoryTool } from "../../resources/tools/search-memory/index.ts";
import { searchMemoryAction } from "./index.ts";

Deno.test("search action publishes a closed output schema through its Tool", () => {
  const action = searchMemoryAction;
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
    searchMemoryTool.outputSchema,
    action.outputSchema,
  );
});
