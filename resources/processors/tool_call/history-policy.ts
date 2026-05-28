import type {
  ToolHistoryPolicy,
  ToolHistoryVisibility,
} from "@/types/index.ts";

export const DEFAULT_TOOL_HISTORY_VISIBILITY: ToolHistoryVisibility =
  "public_status";

export interface HistoryPolicyCapableTool {
  key: string;
  name: string;
  historyPolicy?: ToolHistoryPolicy;
}

export async function projectToolResultForHistory(
  tool: HistoryPolicyCapableTool,
  _args: unknown,
  _output: unknown,
  _error: unknown,
): Promise<{
  visibility: ToolHistoryVisibility;
}> {
  const policy = tool.historyPolicy;
  const visibility = policy?.visibility ?? DEFAULT_TOOL_HISTORY_VISIBILITY;
  return { visibility };
}
