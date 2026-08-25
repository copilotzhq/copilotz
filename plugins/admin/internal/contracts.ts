/** @module Public contracts for the semantic Admin plugin. */
export type CreateAdminPluginOptions = Readonly<{
  id?: string;
  version?: string;
}>;

export type AdminRequest = Readonly<{
  resource: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path?: readonly string[];
  query?: Readonly<Record<string, string | readonly string[] | undefined>>;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  context?: Readonly<Record<string, unknown>>;
}>;

export type AdminResponse = Readonly<{
  status: number;
  headers?: HeadersInit;
  data?: unknown;
  included?: unknown;
  pageInfo?: Readonly<{ next?: string; hasMore: boolean }>;
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
