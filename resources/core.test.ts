import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { coreResources } from "./core.ts";

Deno.test("coreResources registers built-in processors in stable event order", () => {
  assertExists(coreResources.processors);
  assertEquals(
    coreResources.processors.map((processor) => processor.eventType),
    [
      "message.created",
      "message.created",
      "llm_attempt.created",
      "llm_attempt.completed",
      "llm_attempt.failed",
      "tool_execution.created",
      "tool_execution.completed",
      "tool_execution.failed",
      "rag_ingestion.created",
      "entity_extraction.created",
      "long_term_memory.created",
      "NEW_MESSAGE",
      "LLM_CALL",
      "LLM_RESULT",
      "TOOL_CALL",
      "TOOL_RESULT",
      "RAG_INGEST",
      "ENTITY_EXTRACT",
    ],
  );
});

Deno.test("coreResources keeps message.created memory reservation before routing", () => {
  const ids = coreResources.processors
    ?.filter((processor) => processor.eventType === "message.created")
    .map((processor) => processor.id);

  assertEquals(ids, ["memory_reservation", "message_router"]);
});

Deno.test("coreResources registers result processors for success and failure events", () => {
  const llmResultIds = coreResources.processors
    ?.filter((processor) =>
      processor.eventType === "llm_attempt.completed" ||
      processor.eventType === "llm_attempt.failed"
    )
    .map((processor) => processor.id);
  const toolResultIds = coreResources.processors
    ?.filter((processor) =>
      processor.eventType === "tool_execution.completed" ||
      processor.eventType === "tool_execution.failed"
    )
    .map((processor) => processor.id);

  assertEquals(llmResultIds, ["llm_result", "llm_result"]);
  assertEquals(toolResultIds, ["tool_result", "tool_result"]);
});
