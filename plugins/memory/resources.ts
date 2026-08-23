export type LongTermMemoryConfig = Readonly<{
  triggerEstimatedTokens: number;
  retainRecentEstimatedTokens: number;
  maxContentEstimatedTokens: number;
  retrievalLimit: number;
}>;

export const DEFAULT_LONG_TERM_MEMORY_CONFIG: LongTermMemoryConfig = Object
  .freeze({
    triggerEstimatedTokens: 20_000,
    retainRecentEstimatedTokens: 0,
    maxContentEstimatedTokens: 12_000,
    retrievalLimit: 20,
  });
