import { assertEquals } from "@std/assert";
import { projectToolResultProcessor } from "./index.ts";
Deno.test("Tool result projector owns its identity", () =>
  assertEquals(
    projectToolResultProcessor.id,
    "copilotz.core.project-tool-result",
  ));
