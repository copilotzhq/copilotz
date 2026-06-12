import {
  applyUserMemoryOperation,
  getMemoryItems,
} from "./index.ts";
import { assertEquals, assertThrows } from "@std/assert";

Deno.test("applyUserMemoryOperation add appends to memories.items", () => {
  const { metadata, item } = applyUserMemoryOperation({}, {
    operation: "add",
    content: "Prefers bullet points",
    category: "preference",
  });

  assertEquals(item?.content, "Prefers bullet points");
  assertEquals(item?.category, "preference");
  assertEquals(item?.source, "agent");
  assertEquals(getMemoryItems(metadata).length, 1);
});

Deno.test("applyUserMemoryOperation remove deletes by memoryId", () => {
  const base = applyUserMemoryOperation({}, {
    operation: "add",
    content: "First",
    category: "fact",
  }).metadata;

  const memoryId = getMemoryItems(base)[0].id;
  const { metadata } = applyUserMemoryOperation(base, {
    operation: "remove",
    memoryId,
  });

  assertEquals(getMemoryItems(metadata).length, 0);
});

Deno.test("applyUserMemoryOperation remove throws when id missing", () => {
  assertThrows(
    () =>
      applyUserMemoryOperation({}, {
        operation: "remove",
        memoryId: "mem_missing",
      }),
    Error,
    "Memory item not found",
  );
});
