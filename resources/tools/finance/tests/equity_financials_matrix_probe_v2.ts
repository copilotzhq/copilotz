import { acquireCookieAndCrumb, doYahooRequest } from '../client/yahoo-client.ts';

const FIELDS = [
  'operatingcashflowtocurrentliabilities.lasttwelvemonths',
  'ebitdainterestexpense.lasttwelvemonths',
  'ebitinterestexpense.lasttwelvemonths',
  'totalrevenues1yrgrowth.lasttwelvemonths',
  'netincome1yrgrowth.lasttwelvemonths',
  'basicepscontinuingoperations.lasttwelvemonths',
  'quarterlyrevenuegrowth.quarterly',
  'totalrevenues.lasttwelvemonths',
  'total_revenue_market_currency.annual',
  'total_revenue_per_employee_annual_market_currency',
  'netepsbasic.lasttwelvemonths',
  'ebitda1yrgrowth.lasttwelvemonths',
  'dilutedeps1yrgrowth.lasttwelvemonths',
  'netepsdiluted.lasttwelvemonths',
  'netincomeis.lasttwelvemonths',
  'netincomeismarketcurrency.annual',
  'net_income_per_employee_annual_market_currency',
  'operatingincome.lasttwelvemonths',
  'grossprofit.lasttwelvemonths',
  'ebitda.lasttwelvemonths',
  'dilutedepscontinuingoperations.lasttwelvemonths',
  'ebit.lasttwelvemonths',
  'forward_dividend_yield',
] as const;

const CONTROL_KEYS = new Set(['ticker', 'companyName', 'logoUrl']);

function stageBThreshold(field: string): number {
  if (field.includes('per_employee')) return 1_000_000;
  if (field.includes('market_currency.annual')) return 1_000_000_000;
  if (field === 'totalrevenues.lasttwelvemonths' || field === 'netincomeis.lasttwelvemonths' || field === 'operatingincome.lasttwelvemonths' || field === 'grossprofit.lasttwelvemonths' || field === 'ebitda.lasttwelvemonths' || field === 'ebit.lasttwelvemonths') return 1_000_000_000;
  if (field === 'quarterlyrevenuegrowth.quarterly') return 15;
  if (field.includes('growth')) return 0;
  if (field.includes('interestexpense')) return 1;
  if (field.includes('operatingcashflowtocurrentliabilities')) return 1;
  if (field.includes('continuingoperations') || field.includes('neteps')) return 1;
  if (field === 'forward_dividend_yield') return 0;
  return 1;
}

async function post(body: Record<string, unknown>) {
  const { cookie, crumb } = await acquireCookieAndCrumb();
  const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener');
  url.searchParams.set('formatted', 'true');
  url.searchParams.set('useRecordsResponse', 'true');
  url.searchParams.set('lang', 'en-US');
  url.searchParams.set('region', 'US');
  url.searchParams.set('crumb', crumb);
  return await doYahooRequest<any>(url.toString(), cookie, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });
}

function nonNull(v: any) {
  return v !== null && v !== undefined;
}

function inferResponseKeys(records: any[]): string[] {
  const keys = new Set<string>();
  for (const r of records.slice(0, 5)) {
    for (const k of Object.keys(r ?? {})) {
      if (!CONTROL_KEYS.has(k)) keys.add(k);
    }
  }
  return [...keys].sort();
}

async function probeField(field: string) {
  const includeFields = ['ticker', 'companyshortname', field];
  const baseQuery = { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] };
  const result: any = { field, inferredResponseKeys: [], stageA: {}, stageB: {}, stageC: {} };

  try {
    const resA = await post({
      offset: 0, size: 25, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY', topOperator: 'AND', includeFields, query: baseQuery,
    });
    const recordsA = resA?.finance?.result?.[0]?.records ?? [];
    const inferred = inferResponseKeys(recordsA);
    result.inferredResponseKeys = inferred;
    const counts = Object.fromEntries(inferred.map((k) => [k, recordsA.filter((r: any) => nonNull(r?.[k])).length]));
    result.stageA = { ok: true, recordCount: recordsA.length, nonNullCounts: counts, sample: recordsA[0] ?? null };
  } catch (err) {
    result.stageA = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const resB = await post({
      offset: 0, size: 10, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY', topOperator: 'AND', includeFields,
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }, { operator: 'gt', operands: [field, stageBThreshold(field)] }] },
    });
    const recordsB = resB?.finance?.result?.[0]?.records ?? [];
    const inferred = result.inferredResponseKeys?.length ? result.inferredResponseKeys : inferResponseKeys(recordsB);
    const samples = Object.fromEntries(inferred.map((k: string) => [k, recordsB[0]?.[k] ?? null]));
    result.stageB = { ok: true, returnedCount: recordsB.length, sampleValues: samples };
  } catch (err) {
    result.stageB = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const resC = await post({
      offset: 0, size: 10, sortField: field, sortType: 'DESC', quoteType: 'EQUITY', topOperator: 'AND', includeFields, query: baseQuery,
    });
    const recordsC = resC?.finance?.result?.[0]?.records ?? [];
    const inferred = result.inferredResponseKeys?.length ? result.inferredResponseKeys : inferResponseKeys(recordsC);
    const firstValues = Object.fromEntries(inferred.map((k: string) => [k, recordsC.slice(0, 5).map((r: any) => r?.[k] ?? null)]));
    result.stageC = { ok: true, firstValues };
  } catch (err) {
    result.stageC = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return result;
}

const results = [];
for (const field of FIELDS) results.push(await probeField(field));
console.log(JSON.stringify({ results }, null, 2));
