import { assert } from "@std/assert";
import { inspectMemoryTool } from "./index.ts";
Deno.test("inspect tool declaration is exported", () =>
  assert(typeof inspectMemoryTool === "object"));
