import { assertEquals } from "@std/assert";
import { writeFileAction } from "./index.ts";

Deno.test("write_file Action keeps its durable id", () => {
  assertEquals(writeFileAction.id, "copilotz.tools.deno.write_file");
});
