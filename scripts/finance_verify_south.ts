import financeTool from '../resources/tools/finance/index.ts';
import type { FinanceDataProvider } from '../resources/tools/finance/provider/types.ts';

function findYahooFlatKeys(value: any, out = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const v of value) findYahooFlatKeys(v, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (/^(annual|quarterly|trailing)[A-Z]/.test(k)) out.add(k);
      findYahooFlatKeys(v, out);
    }
  }
  return out;
}

function countRows(output: any): number | null {
  if (!output || typeof output !== 'object') return null;
  for (const key of ['results','prices','events','officers','institution_holders','fund_holders','insider_holders','periods']) {
    if (Array.isArray(output[key])) return output[key].length;
  }
  return null;
}

const results: any[] = [];

async function record(name: string, fn: () => Promise<any>) {
  const startedAt = Date.now();
  try {
    const output = await fn();
    results.push({
      name,
      ok: true,
      durationMs: Date.now() - startedAt,
      topKeys: output && typeof output === 'object' ? Object.keys(output).slice(0, 25) : [],
      rowCount: countRows(output),
      truncated: output?.truncated,
      leakedYahooFlatKeys: [...findYahooFlatKeys(output)],
      output,
    });
  } catch (error) {
    results.push({
      name,
      ok: false,
      durationMs: Date.now() - startedAt,
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: String(error?.message ?? error),
    });
  }
}

{
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  (globalThis as any).fetch = async (...args: any[]) => {
    seen.push(String(args?.[0] ?? ''));
    return originalFetch(...args);
  };
  await import(`../resources/tools/finance/index.ts?south_import_check=${Date.now()}`);
  (globalThis as any).fetch = originalFetch;
  results.push({ name: 'import_time_fetches', ok: seen.length === 0, count: seen.length, urls: seen.slice(0, 10) });
}

await record('search_assets', () => financeTool.execute({ action: 'search_assets', query: 'apple', max_rows: 5 }, {} as any));
await record('get_market_snapshot_AAPL', () => financeTool.execute({ action: 'get_market_snapshot', symbol: 'AAPL' }, {} as any));
await record('get_market_snapshot_BTC-USD', () => financeTool.execute({ action: 'get_market_snapshot', symbol: 'BTC-USD' }, {} as any));
await record('get_market_snapshot_^GSPC', () => financeTool.execute({ action: 'get_market_snapshot', symbol: '^GSPC' }, {} as any));
await record('get_company_profile_default', () => financeTool.execute({ action: 'get_company_profile', symbol: 'AAPL' }, {} as any));
await record('get_historical_prices_daily', () => financeTool.execute({ action: 'get_historical_prices', symbol: 'AAPL', frequency: 'daily', max_rows: 5 }, {} as any));
await record('get_analyst_ratings', () => financeTool.execute({ action: 'get_analyst_ratings', symbol: 'AAPL', max_rows: 5 }, {} as any));
await record('get_calendar_events', () => financeTool.execute({ action: 'get_calendar_events', symbol: 'AAPL', max_events: 5 }, {} as any));
await record('get_ownership', () => financeTool.execute({ action: 'get_ownership', symbol: 'AAPL', max_rows: 5 }, {} as any));
await record('get_financial_statements_aapl', () => financeTool.execute({ action: 'get_financial_statements', symbol: 'AAPL', statement_type: 'income_statement', period_type: 'annual', max_periods: 5 }, {} as any));
await record('get_financial_statements_tsla', () => financeTool.execute({ action: 'get_financial_statements', symbol: 'TSLA', statement_type: 'cash_flow', period_type: 'trailing', max_periods: 5 }, {} as any));

await record('bounds_ownership_max_rows_5', () => financeTool.execute({ action: 'get_ownership', symbol: 'AAPL', max_rows: 5 }, {} as any));
await record('bounds_company_profile_officers_3', () => financeTool.execute({ action: 'get_company_profile', symbol: 'AAPL', include_officers: true, max_officers: 3 }, {} as any));
await record('bounds_financials_max_periods_2', () => financeTool.execute({ action: 'get_financial_statements', symbol: 'AAPL', statement_type: 'income_statement', period_type: 'annual', max_periods: 2 }, {} as any));
await record('bounds_calendar_events_2', () => financeTool.execute({ action: 'get_calendar_events', symbol: 'AAPL', max_events: 2 }, {} as any));

await record('weekly_rejection', async () => {
  try {
    await financeTool.execute({ action: 'get_historical_prices', symbol: 'AAPL', frequency: 'weekly' } as any, {} as any);
    return { unexpected: 'accepted weekly' };
  } catch (error) {
    return { threw: true, name: error?.name, code: error?.code, message: String(error?.message ?? error) };
  }
});

await record('upstream_not_found', async () => {
  try {
    await financeTool.execute({ action: 'get_company_profile', symbol: 'ZZZZ_INVALID_SYMBOL_12345' }, {} as any);
    return { unexpected: 'accepted invalid symbol' };
  } catch (error) {
    return { threw: true, name: error?.name, code: error?.code, message: String(error?.message ?? error) };
  }
});

await record('cancellation_historical_prices', async () => {
  const listeners: Array<() => void> = [];
  const context = {
    onCancel(cb: () => void) {
      listeners.push(cb);
    },
  } as any;

  const start = Date.now();
  const promise = financeTool.execute(
    { action: 'get_historical_prices', symbol: 'AAPL', frequency: 'daily', range: '5y', max_rows: 10000 } as any,
    context,
  );

  setTimeout(() => {
    for (const cb of listeners) cb();
  }, 5);
  // Also return unsubscribe function from onCancel to match the real contract
  context.onCancel = (cb: () => void) => {
    listeners.push(cb);
    return () => {
      const idx = listeners.indexOf(cb);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  };

  try {
    const output = await promise;
    return { cancelled: false, durationMs: Date.now() - start, topKeys: Object.keys(output ?? {}) };
  } catch (error) {
    return {
      cancelled: true,
      durationMs: Date.now() - start,
      name: error?.name,
      code: error?.code,
      message: String(error?.message ?? error),
    };
  }
});

await record('provider_seam_static', async () => {
  const src = await Deno.readTextFile('./resources/tools/finance/index.ts');
  const registrySrc = await Deno.readTextFile('./resources/tools/finance/provider/registry.ts');
  const schemaHasOnlyYahoo = src.includes("enum: ['yahoo']") || src.includes('enum: [\'yahoo\']');
  const usesGenericGetProvider = src.includes('getProvider(');
  const registryExportsFactory = registrySrc.includes('export function getProvider');
  return {
    usesGenericGetProvider,
    schemaHasOnlyYahoo,
    registryExportsFactory,
  };
});

class AlphaVantageProviderStub implements FinanceDataProvider {
  async searchAssets() { return { query: 'x', total_results: 0, returned: 0, results: [] }; }
  async getMarketSnapshot() { return { symbol: 'IBM', price: { currency: 'USD' } as any, key_stats: {}, valuation: {}, included: [] } as any; }
  async getCompanyProfile() { return { symbol: 'IBM', included: [], officers: [] } as any; }
  async getHistoricalPrices() { return { symbol: 'IBM', frequency: 'daily', prices: [], events: [], truncated: false } as any; }
  async getAnalystRatings() { return { symbol: 'IBM', recommendations: [], included: [], truncated: false } as any; }
  async getCalendarEvents() { return { symbol: 'IBM', earnings_events: [], dividend_events: [], truncated: false } as any; }
  async getOwnership() { return { symbol: 'IBM', institution_holders: [], fund_holders: [], insider_holders: [], insider_transactions: [], major_holders_breakdown: {}, truncated: false } as any; }
  async getFinancialStatements() { return { symbol: 'IBM', statement_type: 'income_statement', period_type: 'annual', periods: [], coverage: { available: [], missing: [] }, truncated: false } as any; }
}

import { registerProvider } from '../resources/tools/finance/provider/registry.ts';

await record('provider_seam_stub_compiles', async () => {
  const stub = new AlphaVantageProviderStub();
  return {
    hasAllMethods: ['searchAssets','getMarketSnapshot','getCompanyProfile','getHistoricalPrices','getAnalystRatings','getCalendarEvents','getOwnership','getFinancialStatements'].every((k) => typeof (stub as any)[k] === 'function'),
  };
});

await record('provider_seam_empirical_execution', async () => {
  const stub = new AlphaVantageProviderStub();
  registerProvider('stub', stub);
  const output = await financeTool.execute({ action: 'get_market_snapshot', symbol: 'IBM', provider: 'stub' }, {} as any);
  return {
    executedStubSuccessfully: output.symbol === 'IBM' && output.price?.currency === 'USD',
    output,
  };
});

await Deno.writeTextFile('./probe/finance_south_results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
