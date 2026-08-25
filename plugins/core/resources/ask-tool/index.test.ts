import { assertEquals } from "@std/assert";
import { askTool } from "./index.ts";
Deno.test("Ask Tool maps the Ask Action alias", () =>
  assertEquals(askTool.action, "ask"));
