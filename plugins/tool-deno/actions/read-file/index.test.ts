import { assertEquals } from "@std/assert";
import { readFileAction } from "./index.ts";

Deno.test("read_file Action keeps its durable id", () => {
  assertEquals(readFileAction.id, "copilotz.tools.deno.read_file");
});
