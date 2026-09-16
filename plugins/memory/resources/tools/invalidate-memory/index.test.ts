import { assert } from "@std/assert";
import { invalidateMemoryTool } from "./index.ts";
Deno.test("invalidate tool declaration is exported", () =>
  assert(typeof invalidateMemoryTool === "object"));
