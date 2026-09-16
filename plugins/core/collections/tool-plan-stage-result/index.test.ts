import { assertEquals } from "@std/assert";
import { toolPlanStageResultCollection } from "./index.ts";
Deno.test("Tool Plan result Collection owns its name", () =>
  assertEquals(toolPlanStageResultCollection.name, "toolPlanStageResult"));
