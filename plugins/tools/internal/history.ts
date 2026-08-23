import { estimateTextTokens } from "@copilotz/copilotz/tokens";
import { wellFormedUnicodePrefix } from "../../../utils/unicode.ts";

export type ToolHistoryReference = Readonly<{
  toolExecutionId?: string;
  toolResultEventId?: string;
  /** Legacy readback field retained until the v2 history adapter is removed. */
  toolResultQueueEventId?: string;
}>;

/** Bounds one model-visible tool result while retaining a durable readback ID. */
export function truncateToolOutputForHistory(
  maxEstimatedTokens: number | undefined,
  value: unknown,
  references: ToolHistoryReference = {},
): unknown {
  if (
    typeof maxEstimatedTokens !== "number" || maxEstimatedTokens <= 0
  ) return value;
  if (maxEstimatedTokens < 12) return "[tool output truncated]";
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  if (estimateTextTokens(serialized) <= maxEstimatedTokens) return value;

  const envelope = (preview: string) => ({
    _copilotz_history_truncated: true as const,
    preview,
    originalSerializedLength: serialized.length,
    ...(references.toolExecutionId
      ? { toolExecutionId: references.toolExecutionId }
      : {}),
    ...(references.toolResultEventId
      ? { toolResultEventId: references.toolResultEventId }
      : {}),
    ...(references.toolResultQueueEventId
      ? { toolResultQueueEventId: references.toolResultQueueEventId }
      : {}),
  });
  let previewLength = Math.max(0, maxEstimatedTokens * 4 - 200);
  while (previewLength > 0) {
    const candidate = envelope(
      wellFormedUnicodePrefix(serialized, previewLength),
    );
    if (
      estimateTextTokens(JSON.stringify(candidate)) <= maxEstimatedTokens
    ) return candidate;
    previewLength = Math.floor(previewLength * 0.88);
  }
  return envelope("");
}
