import { assert } from "@std/assert";
import { CORE_MEMORY_KINDS } from "./index.ts";
Deno.test("memory ontology includes core kinds", () =>
  assert(CORE_MEMORY_KINDS.length > 0));
