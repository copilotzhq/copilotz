import financeTool from '../resources/tools/finance/index.ts';

const samples: Array<{name:string,args:any}> = [
  { name: 'search_assets', args: { action: 'search_assets', query: 'apple', max_rows: 3 } },
  { name: 'get_market_snapshot_stock', args: { action: 'get_market_snapshot', symbol: 'AAPL' } },
  { name: 'get_market_snapshot_crypto', args: { action: 'get_market_snapshot', symbol: 'BTC-USD' } },
  { name: 'get_market_snapshot_index', args: { action: 'get_market_snapshot', symbol: '^GSPC' } },
  { name: 'get_company_profile', args: { action: 'get_company_profile', symbol: 'AAPL' } },
  { name: 'get_historical_prices', args: { action: 'get_historical_prices', symbol: 'AAPL', frequency: 'daily', max_rows: 5 } },
  { name: 'get_analyst_ratings', args: { action: 'get_analyst_ratings', symbol: 'AAPL', max_rows: 5 } },
  { name: 'get_calendar_events', args: { action: 'get_calendar_events', symbol: 'AAPL', max_events: 5 } },
  { name: 'get_ownership', args: { action: 'get_ownership', symbol: 'AAPL', max_rows: 5 } },
  { name: 'get_financial_statements_aapl', args: { action: 'get_financial_statements', symbol: 'AAPL', statement_type: 'income_statement', period_type: 'annual', max_periods: 5 } },
  { name: 'get_financial_statements_tsla_cf', args: { action: 'get_financial_statements', symbol: 'TSLA', statement_type: 'cash_flow', period_type: 'trailing', max_periods: 5 } },
];

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

const results: any[] = [];
for (const sample of samples) {
  const startedAt = Date.now();
  try {
    const output = await financeTool.execute(sample.args, {} as any);
    const leakedKeys = [...findYahooFlatKeys(output)];
    results.push({
      name: sample.name,
      ok: true,
      durationMs: Date.now() - startedAt,
      bytes: JSON.stringify(output).length,
      truncated: output?.truncated,
      leakedYahooFlatKeys: leakedKeys,
      topKeys: output && typeof output === 'object' ? Object.keys(output).slice(0, 25) : [],
      output,
    });
  } catch (error) {
    results.push({
      name: sample.name,
      ok: false,
      durationMs: Date.now() - startedAt,
      errorName: error?.name,
      errorCode: error?.code,
      errorMessage: String(error?.message ?? error),
    });
  }
}

try {
  await financeTool.execute({ action: 'get_historical_prices', symbol: 'AAPL', frequency: 'weekly' } as any, {} as any);
  results.push({ name: 'weekly_rejection', ok: false, errorMessage: 'weekly unexpectedly accepted' });
} catch (error) {
  results.push({
    name: 'weekly_rejection',
    ok: true,
    errorName: error?.name,
    errorCode: error?.code,
    errorMessage: String(error?.message ?? error),
  });
}

const originalFetch = globalThis.fetch;
const seen: string[] = [];
(globalThis as any).fetch = async (...args: any[]) => {
  seen.push(String(args?.[0] ?? ''));
  return originalFetch(...args);
};
await import(`../resources/tools/finance/index.ts?import_check=${Date.now()}`);
(globalThis as any).fetch = originalFetch;
results.push({ name: 'import_time_fetches', ok: true, count: seen.length, urls: seen.slice(0, 10) });

await Deno.writeTextFile('../../probe/finance_smoke_results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
