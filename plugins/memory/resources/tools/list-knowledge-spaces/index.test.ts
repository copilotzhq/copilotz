import { assert } from "@std/assert";
import { listKnowledgeSpacesTool } from "./index.ts";
Deno.test("space tool declaration is exported", () =>
  assert(typeof listKnowledgeSpacesTool === "object"));
