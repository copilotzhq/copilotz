import { assert } from "@std/assert";
import { createListKnowledgeSpacesTool } from "./index.ts";
Deno.test("space tool factory is exported", () =>
  assert(typeof createListKnowledgeSpacesTool === "function"));
