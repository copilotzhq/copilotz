import { acquireCookieAndCrumb, doYahooRequest } from '../resources/tools/finance/client/yahoo-client.ts';

function json(v: unknown) {
  return JSON.stringify(v, null, 2);
}

async function postScreener(body: Record<string, unknown>) {
  const { cookie, crumb } = await acquireCookieAndCrumb();
  const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener');
  url.searchParams.set('formatted', 'true');
  url.searchParams.set('useRecordsResponse', 'true');
  url.searchParams.set('lang', 'en-US');
  url.searchParams.set('region', 'US');
  url.searchParams.set('crumb', crumb);
  const started = Date.now();
  try {
    const res = await doYahooRequest<any>(url.toString(), cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 30000,
    });
    return {
      ok: true,
      durationMs: Date.now() - started,
      request: body,
      result0Keys: Object.keys(res?.finance?.result?.[0] ?? {}),
      result0Meta: {
        start: res?.finance?.result?.[0]?.start ?? null,
        count: res?.finance?.result?.[0]?.count ?? null,
        total: res?.finance?.result?.[0]?.total ?? null,
      },
      result0Raw: res?.finance?.result?.[0] ?? null,
      sampleRecord: res?.finance?.result?.[0]?.records?.[0] ?? res?.finance?.result?.[0]?.quotes?.[0] ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      request: body,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

const cases: Array<{ name: string; body: Record<string, unknown> }> = [
  {
    name: 'A1_equity_shape_includeFields_empty',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: [],
      userId: '',
      userIdType: 'guid',
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'B3_sector_technology',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'companyshortname', 'sector', 'industry', 'region'],
      query: { operator: 'and', operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'eq', operands: ['sector', 'Technology'] },
      ] },
    },
  },
  {
    name: 'B4_industry_semiconductors',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'companyshortname', 'sector', 'industry', 'region'],
      query: { operator: 'and', operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'eq', operands: ['industry', 'Semiconductors'] },
      ] },
    },
  },
  {
    name: 'B5_multi_sector',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'companyshortname', 'sector', 'industry', 'region'],
      query: { operator: 'and', operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'or', operands: [
          { operator: 'eq', operands: ['sector', 'Technology'] },
          { operator: 'eq', operands: ['sector', 'Healthcare'] },
        ] },
      ] },
    },
  },
  {
    name: 'C6_composite_fields',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'peratio.lasttwelvemonths', 'returnonequity.lasttwelvemonths', 'esg_score', 'intradaymarketcap'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'D7_sort_intradaymarketcap',
    body: {
      offset: 0,
      size: 5,
      sortField: 'intradaymarketcap',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'intradaymarketcap'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'D7_sort_peratio_lasttwelvemonths',
    body: {
      offset: 0,
      size: 5,
      sortField: 'peratio.lasttwelvemonths',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'peratio.lasttwelvemonths'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'D8_sort_not_real',
    body: {
      offset: 0,
      size: 5,
      sortField: 'not_a_real_field',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'E9_currency_field',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'currency'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'F11_size_100',
    body: {
      offset: 0,
      size: 100,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'F11_size_200',
    body: {
      offset: 0,
      size: 200,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker'],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'G12_gt_pe_ratio',
    body: {
      offset: 0,
      size: 5,
      sortField: 'peratio.lasttwelvemonths',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'peratio.lasttwelvemonths'],
      query: { operator: 'and', operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'gt', operands: ['peratio.lasttwelvemonths', 15] },
      ] },
    },
  },
  {
    name: 'G13_btwn_marketcap',
    body: {
      offset: 0,
      size: 5,
      sortField: 'intradaymarketcap',
      sortType: 'DESC',
      quoteType: 'EQUITY',
      topOperator: 'AND',
      includeFields: ['ticker', 'intradaymarketcap'],
      query: { operator: 'and', operands: [
        { operator: 'eq', operands: ['region', 'us'] },
        { operator: 'btwn', operands: ['intradaymarketcap', 1000000000, 100000000000] },
      ] },
    },
  },
  {
    name: 'H14_etf_shape',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'ETF',
      topOperator: 'AND',
      includeFields: [],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
  {
    name: 'H14_mutualfund_shape',
    body: {
      offset: 0,
      size: 5,
      sortField: 'ticker',
      sortType: 'DESC',
      quoteType: 'MUTUALFUND',
      topOperator: 'AND',
      includeFields: [],
      query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
    },
  },
];

const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  cases: {},
};

for (const c of cases) {
  console.log(`=== ${c.name} ===`);
  const res = await postScreener(c.body);
  (out.cases as Record<string, unknown>)[c.name] = res;
  console.log(json({
    ok: (res as any).ok,
    durationMs: (res as any).durationMs,
    errorMessage: (res as any).errorMessage ?? null,
    result0Keys: (res as any).result0Keys ?? null,
    result0Meta: (res as any).result0Meta ?? null,
    sampleRecordKeys: Object.keys((res as any).sampleRecord ?? {}),
  }));
}

await Deno.writeTextFile('probe/equity_probe_response.json', json(out));
console.log('WROTE probe/equity_probe_response.json');
