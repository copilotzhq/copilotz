import { assert } from "@std/assert";
import { searchMemoryTool } from "./index.ts";
Deno.test("search tool declaration is exported", () =>
  assert(typeof searchMemoryTool === "object"));
