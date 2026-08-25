import { assert } from "@std/assert";
import { createSearchMemoryTool } from "./index.ts";
Deno.test("search tool factory is exported", () =>
  assert(typeof createSearchMemoryTool === "function"));
