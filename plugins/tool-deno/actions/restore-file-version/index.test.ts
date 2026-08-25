import { assertEquals } from "@std/assert";
import { restoreFileVersionAction } from "./index.ts";

Deno.test("restore_file_version Action keeps its durable id", () => {
  assertEquals(
    restoreFileVersionAction.id,
    "copilotz.tools.deno.restore_file_version",
  );
});
