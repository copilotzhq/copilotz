/** Fetch client for authorized Usage analytics, independent of React and Admin. @module */
import type { UsageDataSource } from "./types.ts";
export type * from "./types.ts";
export interface UsageClientOptions {
  baseUrl?: string;
  getRequestHeaders?: () =>
    | HeadersInit
    | undefined
    | Promise<HeadersInit | undefined>;
  fetch?: typeof fetch;
}
export function createUsageClient(
  options: UsageClientOptions = {},
): UsageDataSource {
  const base = (options.baseUrl ?? "/api/admin/usage").replace(/\/$/, "");
  const fetcher = options.fetch ?? globalThis.fetch;
  async function get<T>(
    path: string,
    values: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      search.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    const response = await fetcher(`${base}${path}?${search}`, {
      headers: await options.getRequestHeaders?.(),
      credentials: "include",
      signal,
    });
    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message ?? payload?.message;
      throw new Error(
        typeof message === "string"
          ? message
          : `Usage request failed (${response.status}).`,
      );
    }
    return payload as T;
  }
  return ({
    analytics: ({ filters, groupBy, interval, signal }) =>
      get("", { ...filters, groupBy, interval }, signal),
    attempts: ({ filters, after, limit, signal }) =>
      get("/attempts", { ...filters, after, limit }, signal),
  } satisfies UsageDataSource);
}
