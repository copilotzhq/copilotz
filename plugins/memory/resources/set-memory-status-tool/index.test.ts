import { assert } from "@std/assert";
import { createSetMemoryStatusTool } from "./index.ts";
Deno.test("status tool factory is exported", () =>
  assert(typeof createSetMemoryStatusTool === "function"));
