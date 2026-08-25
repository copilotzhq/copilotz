import { assertEquals } from "@std/assert";
import { projectTextResultProcessor } from "./index.ts";
Deno.test("Text result projector owns its identity", () =>
  assertEquals(
    projectTextResultProcessor.id,
    "copilotz.core.project-llm-result",
  ));
