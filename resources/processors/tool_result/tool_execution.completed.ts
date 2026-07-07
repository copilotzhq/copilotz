export const processorId = "tool_result";
export const eventTypes = ["tool_execution.completed"] as const;

export { process, shouldProcess, toolResultProcessor } from "./_shared.ts";
