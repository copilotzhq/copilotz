import { assert } from "@std/assert";
import { createInspectMemoryTool } from "./index.ts";
Deno.test("inspect tool factory is exported", () =>
  assert(typeof createInspectMemoryTool === "function"));
