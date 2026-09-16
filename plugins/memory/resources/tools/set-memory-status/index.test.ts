import { assert } from "@std/assert";
import { setMemoryStatusTool } from "./index.ts";
Deno.test("status tool declaration is exported", () =>
  assert(typeof setMemoryStatusTool === "object"));
