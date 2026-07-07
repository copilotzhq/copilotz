export const processorId = "tool_result";
export const eventTypes = ["tool_execution.failed"] as const;

export { process, shouldProcess, toolResultProcessor } from "./_shared.ts";
