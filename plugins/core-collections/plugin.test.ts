import { assertEquals } from "@std/assert";
import { coreCollectionsPlugin } from "./plugin.ts";

Deno.test("Core Collections composes the storage-only boundary", () => {
  assertEquals(coreCollectionsPlugin.id, "@copilotz/core-collections");
  assertEquals(Object.keys(coreCollectionsPlugin.collections), [
    "participant",
    "thread",
    "message",
    "toolPlan",
    "toolPlanStageResult",
  ]);
  assertEquals(Object.keys(coreCollectionsPlugin.processors), ["messageInput"]);
});
