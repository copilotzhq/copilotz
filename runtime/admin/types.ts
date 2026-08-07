export type CreateAdminPluginOptions = Readonly<{
  id?: string;
  version?: string;
  featureId?: string;
}>;

export type AdminUsageTotals = Readonly<{
  totalCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  totalCostUsd: number;
}>;

export type AdminActivityPoint =
  & AdminUsageTotals
  & Readonly<{
    bucket: string;
    messageCount: number;
    toolCallCount: number;
  }>;
