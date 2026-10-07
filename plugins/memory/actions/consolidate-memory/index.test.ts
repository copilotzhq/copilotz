import { assertEquals } from "@std/assert";
import { memoryProposalSchema } from "../../authoring/notes/index.ts";
import { consolidateMemoryTool } from "../../resources/tools/consolidate-memory/index.ts";
import { consolidateMemoryAction } from "./index.ts";

Deno.test("consolidation publishes the same concise contract through its Action and Tool", () => {
  assertEquals(
    consolidateMemoryAction.id,
    "copilotz.memory.consolidation.commit",
  );
  assertEquals(consolidateMemoryAction.inputSchema, memoryProposalSchema);
  assertEquals(consolidateMemoryTool.inputSchema, memoryProposalSchema);
  assertEquals(
    consolidateMemoryTool.outputSchema,
    consolidateMemoryAction.outputSchema,
  );
});
