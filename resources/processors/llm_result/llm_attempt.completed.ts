export const processorId = "llm_result";
export const eventTypes = ["llm_attempt.completed"] as const;

export { llmResultProcessor, process, shouldProcess } from "./_shared.ts";
