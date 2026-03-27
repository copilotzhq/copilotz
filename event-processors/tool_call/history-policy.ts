import type {
  ToolHistoryPolicy,
  ToolHistoryVisibility,
  ToolResultProjectorContext,
} from "@/interfaces/index.ts";

export const DEFAULT_TOOL_HISTORY_VISIBILITY: ToolHistoryVisibility =
  "public_full";

export interface HistoryPolicyCapableTool {
  key: string;
  name: string;
  historyPolicy?: ToolHistoryPolicy;
}

export async function projectToolResultForHistory(
  tool: HistoryPolicyCapableTool,
  args: unknown,
  output: unknown,
  error: unknown,
): Promise<{
  visibility: ToolHistoryVisibility;
  projectedOutput?: unknown;
}> {
  const policy = tool.historyPolicy;
  const visibility = policy?.visibility ?? DEFAULT_TOOL_HISTORY_VISIBILITY;
  if (visibility !== "public_result") {
    return { visibility };
  }

  const baseOutput = typeof output !== "undefined" ? output : error;
  if (!policy?.projector) {
    return { visibility, projectedOutput: baseOutput };
  }

  try {
    const projectorContext: ToolResultProjectorContext = {
      toolKey: tool.key,
      toolName: tool.name,
      status: typeof error === "undefined" ? "completed" : "failed",
      ...(typeof error !== "undefined" ? { error } : {}),
    };
    const projectedOutput = await policy.projector(
      args,
      baseOutput,
      projectorContext,
    );
    return { visibility, projectedOutput };
  } catch (projectorError) {
    console.warn(
      `Tool result projector failed for "${tool.key}":`,
      projectorError,
    );
    return { visibility, projectedOutput: baseOutput };
  }
}
