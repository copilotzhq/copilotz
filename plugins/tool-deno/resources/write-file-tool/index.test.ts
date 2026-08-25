import { assertEquals } from "@std/assert";
import { writeFileTool } from "./index.ts";

Deno.test("write_file Tool maps to its Action alias", () => {
  assertEquals(writeFileTool.action, "write_file");
});
