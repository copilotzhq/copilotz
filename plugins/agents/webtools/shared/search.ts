/**
 * Searching, metered like a model call: the listeners of `modelUse` may
 * refuse it first (a budget spent), then the `spending` check, and its use
 * (one `search` query) is told to the ledger, which prices it from the app's
 * `cost` and `price` resources by subject (`"serper": { queries: 0.001, per: 1 }`).
 */
import { type Context, failure } from "../../../../runtime/mod.ts";
import { mayUse, used } from "../../../models/contract.ts";
import type { SearchAdapter, SearchResult } from "../contract.ts";
import { settingsOf } from "./settings.ts";

export type Ask = { query: string; count?: number; language?: string; country?: string };

export async function search(ctx: Context, ask: Ask): Promise<SearchResult[]> {
  const s = settingsOf(ctx);
  const query = ask.query.trim();
  if (!query) throw failure("invalid", "A search needs a query");
  const adapter = ctx.adapters.search?.[s.search.adapter] as SearchAdapter | undefined;
  if (!adapter) throw failure("invalid", `No search adapter "${s.search.adapter}"`);
  const subject = adapter.subject ?? s.search.adapter;

  const tags = { purpose: "search" };
  await mayUse(ctx, { meter: "search", subject, tags });
  const spending = ctx.resources.spending as { check?: string } | undefined;
  if (spending?.check) {
    const verdict = await ctx.as().call<{ ok: boolean; why?: string; message?: string }>(
      spending.check,
      { purpose: "search" },
    );
    if (!verdict.ok) {
      throw Object.assign(
        failure(verdict.why ?? "spending", verdict.message ?? "This org can't spend right now."),
        { final: true },
      );
    }
  }

  const stop = AbortSignal.any([ctx.signal, AbortSignal.timeout(s.timeout)]);
  let results: SearchResult[];
  try {
    results = await adapter.search({
      connection: {
        apiKey: s.search.apiKey,
        endpoint: s.search.endpoint,
        options: s.search.options,
      },
      query,
      count: Math.max(1, Math.min(Math.floor(ask.count ?? 5), s.search.maxResults)),
      ...(ask.language ? { language: ask.language } : {}),
      ...(ask.country ? { country: ask.country } : {}),
      fetch: ctx.fetch,
      signal: stop,
    });
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
    if (stop.aborted) throw failure("timeout", "The search engine didn't answer in time");
    throw error;
  }
  await used(ctx, { meter: "search", subject, quantities: { queries: 1 }, tags });
  return results;
}
