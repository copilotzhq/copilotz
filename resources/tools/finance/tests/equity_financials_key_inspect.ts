import { acquireCookieAndCrumb, doYahooRequest } from '../client/yahoo-client.ts';

const includeFields = [
  'ticker',
  'companyshortname',
  'forward_dividend_yield',
  'operatingcashflowtocurrentliabilities.lasttwelvemonths',
  'ebitdainterestexpense.lasttwelvemonths',
  'ebitinterestexpense.lasttwelvemonths',
  'totalrevenues.lasttwelvemonths',
  'netincomeis.lasttwelvemonths',
  'ebitda.lasttwelvemonths',
  'ebit.lasttwelvemonths',
  'quarterlyrevenuegrowth.quarterly'
];

const { cookie, crumb } = await acquireCookieAndCrumb();
const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener');
url.searchParams.set('formatted', 'true');
url.searchParams.set('useRecordsResponse', 'true');
url.searchParams.set('lang', 'en-US');
url.searchParams.set('region', 'US');
url.searchParams.set('crumb', crumb);

const body = {
  offset: 0,
  size: 5,
  sortField: 'intradaymarketcap',
  sortType: 'DESC',
  quoteType: 'EQUITY',
  topOperator: 'AND',
  includeFields,
  query: { operator: 'and', operands: [{ operator: 'eq', operands: ['region', 'us'] }] },
};

const res = await doYahooRequest<any>(url.toString(), cookie, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(body),
  timeoutMs: 30000,
});

const records = res?.finance?.result?.[0]?.records ?? [];
console.log(JSON.stringify({
  includeFields,
  recordCount: records.length,
  sampleKeys: Object.keys(records[0] ?? {}).sort(),
  sampleRecord: records[0] ?? null,
}, null, 2));
