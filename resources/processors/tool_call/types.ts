import type { Tool } from "@/types/index.ts";

export type ToolExecutor = (
  args: unknown,
  context?: unknown,
) => Promise<unknown> | unknown;

export type ExecutableTool = Tool & {
  execute: ToolExecutor;
};
