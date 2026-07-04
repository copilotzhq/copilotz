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

type ProbeResult = {
  field: string;
  stageA: {
    ok: boolean;
    presentCount?: number;
    nonNullCount?: number;
    sampleValue?: unknown;
    error?: string;
  };
  stageB: {
    ok: boolean;
    returnedCount?: number;
    sampleValue?: unknown;
    error?: string;
  };
  stageC: {
    ok: boolean;
    firstValues?: unknown[];
    error?: string;
  };
};

function stageBThreshold(field: string): number {
  if (field.includes('per_employee')) return 1_000_000;
  if (field.includes('market_currency.annual')) return 1_000_000_000;
  if (field.includes('lasttwelvemonths') && (
    field.startsWith('totalrevenues') ||
    field.startsWith('netincomeis') ||
    field.startsWith('operatingincome') ||
    field.startsWith('grossprofit') ||
    field.startsWith('ebitda.') ||
    field === 'ebit.lasttwelvemonths'
  )) return 1_000_000_000;
  if (field.includes('growth')) return 0;
  if (field.includes('quarterlyrevenuegrowth')) return 15;
  if (field.includes('interestexpense')) return 1;
  if (field.includes('operatingcashflowtocurrentliabilities')) return 1;
  if (field.includes('continuingoperations') || field.includes('neteps')) return 1;
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

async function probeField(field: string): Promise<ProbeResult> {
  const baseQuery = { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] };
  const includeFields = [
    'ticker',
    'companyshortname',
    'intradaymarketcap',
    field,
  ];

  const out: ProbeResult = {
    field,
    stageA: { ok: false },
    stageB: { ok: false },
    stageC: { ok: false },
  };

  try {
    const res = await post({
      offset: 0,
      size: 25,
      sortField: 'intradaymarketcap',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields,
      query: baseQuery,
    });
    const records = res?.finance?.result?.[0]?.records ?? [];
    const presentCount = records.filter((r: any) => Object.prototype.hasOwnProperty.call(r, field)).length;
    const nonNull = records.map((r: any) => r?.[field]).filter((v: unknown) => v !== null && v !== undefined);
    out.stageA = {
      ok: true,
      presentCount,
      nonNullCount: nonNull.length,
      sampleValue: nonNull[0] ?? null,
    };
  } catch (err) {
    out.stageA = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const threshold = stageBThreshold(field);
    const res = await post({
      offset: 0,
      size: 10,
      sortField: 'intradaymarketcap',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields,
      query: {
        operator: 'and',
        operands: [
          { operator: 'eq', operands: ['region', 'us'] },
          { operator: 'gt', operands: [field, threshold] },
        ],
      },
    });
    const records = res?.finance?.result?.[0]?.records ?? [];
    out.stageB = {
      ok: true,
      returnedCount: records.length,
      sampleValue: records[0]?.[field] ?? null,
    };
  } catch (err) {
    out.stageB = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await post({
      offset: 0,
      size: 10,
      sortField: field,
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields,
      query: baseQuery,
    });
    const records = res?.finance?.result?.[0]?.records ?? [];
    out.stageC = {
      ok: true,
      firstValues: records.slice(0, 5).map((r: any) => r?.[field] ?? null),
    };
  } catch (err) {
    out.stageC = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  return out;
}

const results: ProbeResult[] = [];
for (const field of FIELDS) {
  results.push(await probeField(field));
}

console.log(JSON.stringify({ fields: FIELDS, results }, null, 2));
