import { assertEquals } from "@std/assert";
import { toolPlanCoordinatorProcessor } from "./index.ts";
Deno.test("Tool Plan coordinator owns its identity", () =>
  assertEquals(
    toolPlanCoordinatorProcessor.id,
    "copilotz.core.tool-plan-coordinator",
  ));
