export type ReasoningHistoryInclude = "none" | "self" | "all";

/** Core prompt policy for selecting prior reasoning content. */
export type ReasoningHistoryOptions = Readonly<{
  include?: ReasoningHistoryInclude;
  maxEstimatedTokens?: number;
}>;
