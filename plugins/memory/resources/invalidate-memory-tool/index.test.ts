import { assert } from "@std/assert";
import { createInvalidateMemoryTool } from "./index.ts";
Deno.test("invalidate tool factory is exported", () =>
  assert(typeof createInvalidateMemoryTool === "function"));
