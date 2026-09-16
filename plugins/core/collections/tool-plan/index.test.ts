import { assertEquals } from "@std/assert";
import { toolPlanCollection } from "./index.ts";
Deno.test("Tool Plan Collection owns its name", () =>
  assertEquals(toolPlanCollection.name, "toolPlan"));
