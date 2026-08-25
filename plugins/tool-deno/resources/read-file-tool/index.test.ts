import { assertEquals } from "@std/assert";
import { readFileTool } from "./index.ts";

Deno.test("read_file Tool maps to its Action alias", () => {
  assertEquals(readFileTool.action, "read_file");
});
