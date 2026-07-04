import { Tool } from '../../../types/index.ts';
import { getProvider } from './provider/registry.ts';
import { FinanceError } from './client/errors.ts';

const financeTool: Tool = {
  id: 'finance',
  key: 'finance',
  name: 'Finance Data',
  description: `Finance data tool backed by Yahoo Finance with a swappable provider interface.

Actions:
- search_assets: Discover tickers by free-text query (with optional quote_type/exchange/sector/industry filters).
- get_market_snapshot: Current price, valuation ratios, and key statistics for a symbol.
- get_company_profile: Company background, sector, industry, officers (opt-in).
- get_historical_prices: OHLCV bars + adjClose + corporate actions (daily or monthly).
- get_analyst_ratings: Analyst consensus, recommendation trend, upgrade/downgrade history, target prices.
- get_calendar_events: Upcoming earnings dates and dividend events.
- get_ownership: Institutional, fund, and insider ownership positions.
- get_financial_statements: Income statement / balance sheet / cash flow / key stats by period (annual/quarterly/trailing) with explicit coverage metadata.

Always returns bounded outputs. Supports cancellation via framework context.onCancel.`,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Which finance operation to perform.',
        enum: [
          'search_assets',
          'get_market_snapshot',
          'get_company_profile',
          'get_historical_prices',
          'get_analyst_ratings',
          'get_calendar_events',
          'get_ownership',
          'get_financial_statements',
          'screen_securities',
        ],
      },
    },
    required: ['action'],
    oneOf: [
      {
        title: 'search_assets',
        type: 'object',
        properties: {
          action: { const: 'search_assets' },
          query: {
            type: 'string',
            description: 'Free-text search query for action=search_assets. Minimum 1 character, max 100.',
            minLength: 1,
            maxLength: 100,
          },
          quote_type: {
            type: 'string',
            description: 'Filter search results by asset class.',
            enum: ['equity', 'etf', 'mutualfund', 'index', 'future', 'currency', 'cryptocurrency'],
          },
          exchange: {
            type: 'string',
            description: 'Exchange code filter, e.g. "NMS", "NYQ", "LSE".',
          },
          sector: {
            type: 'string',
            description: 'Filter search results by sector.',
          },
          industry: {
            type: 'string',
            description: 'Filter search results by industry.',
          },
          limit: {
            type: 'number',
            minimum: 1,
            maximum: 50,
            default: 10,
            description: 'Max results to return (search_assets). Default 10.',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'query'],
        additionalProperties: false,
      },
      {
        title: 'get_market_snapshot',
        type: 'object',
        properties: {
          action: { const: 'get_market_snapshot' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_company_profile',
        type: 'object',
        properties: {
          action: { const: 'get_company_profile' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          include_officers: {
            type: 'boolean',
            default: false,
            description: 'Include company officers (company_profile). Officers are heavy; default off.',
          },
          max_officers: {
            type: 'number',
            minimum: 1,
            maximum: 50,
            default: 5,
            description: 'Max company officers to return (company_profile).',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_historical_prices',
        type: 'object',
        properties: {
          action: { const: 'get_historical_prices' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          start_date: {
            type: 'string',
            description: 'YYYY-MM-DD for historical_prices.',
          },
          end_date: {
            type: 'string',
            description: 'YYYY-MM-DD for historical_prices.',
          },
          frequency: {
            type: 'string',
            enum: ['daily', 'monthly'],
            default: 'daily',
            description: 'Bar frequency. daily → Yahoo 1d, monthly → Yahoo 1mo. Weekly NOT supported.',
          },
          max_rows: {
            type: 'number',
            minimum: 1,
            maximum: 10000,
            default: 1000,
            description: 'Cap on returned rows (historical_prices). Default 1000.',
          },
          include_corporate_actions: {
            type: 'boolean',
            default: true,
            description: 'Include dividends and splits in the date range (historical_prices).',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_analyst_ratings',
        type: 'object',
        properties: {
          action: { const: 'get_analyst_ratings' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          months_back: {
            type: 'number',
            minimum: 1,
            maximum: 60,
            default: 12,
            description: 'How many months back to retrieve analyst action history.',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_calendar_events',
        type: 'object',
        properties: {
          action: { const: 'get_calendar_events' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          max_events: {
            type: 'number',
            minimum: 1,
            maximum: 50,
            default: 20,
            description: 'Max calendar events to return.',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_ownership',
        type: 'object',
        properties: {
          action: { const: 'get_ownership' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          max_rows: {
            type: 'number',
            minimum: 1,
            maximum: 10000,
            default: 1000,
            description: 'Cap on returned rows (ownership). Default 1000.',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_financial_statements',
        type: 'object',
        properties: {
          action: { const: 'get_financial_statements' },
          symbol: {
            type: 'string',
            description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC").',
          },
          statement_type: {
            type: 'string',
            enum: ['income_statement', 'balance_sheet', 'cash_flow', 'key_stats'],
            description: 'Which financial statement (financial_statements).',
          },
          period_type: {
            type: 'string',
            enum: ['annual', 'quarterly', 'trailing'],
            description: 'Period granularity (financial_statements).',
          },
          max_periods: {
            type: 'number',
            minimum: 1,
            maximum: 20,
            default: 5,
            description: 'Number of most recent periods to return (financial_statements). Default 5.',
          },
          provider: {
            type: 'string',
            default: 'yahoo',
            description: 'Optional provider override (e.g. "yahoo").',
          },
        },
        required: ['action', 'symbol', 'statement_type', 'period_type'],
        additionalProperties: false,
      },
      {
        title: 'screen_securities',
        type: 'object',
        properties: {
          action: { const: 'screen_securities' },
          quoteType: {
            type: 'string',
            enum: ['INDEX', 'EQUITY', 'ETF', 'MUTUALFUND'],
            description: 'The type of security to screen.',
          },
        },
        required: ['action', 'quoteType'],
        oneOf: [
          {
            properties: {
              action: { const: 'screen_securities' },
              quoteType: { const: 'INDEX' },
              regions: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: [
                    'us', 'ca', 'gb', 'fr', 'de', 'jp', 'hk', 'au', 'in', 'br', 'cn', 'kr', 'tw', 'ch', 'nl', 'se', 'es', 'it', 'sg', 'mx', 'za', 'ru', 'sa', 'tr', 'id', 'th', 'my', 'ph', 'vn', 'pl', 'be', 'at', 'fi', 'no', 'dk', 'ie', 'pt', 'gr', 'il', 'nz', 'co', 'cl', 'pe', 'ar', 'cz', 'hu', 'ro', 'ua', 'ae', 'qa'
                  ],
                },
                description: 'Filter by region/country codes (e.g. ["us", "ca"]).',
              },
              exchanges: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: [
                    'nyq', 'nms', 'ams', 'par', 'ger', 'fra', 'stu', 'mun', 'ber', 'dus', 'ham', 'han', 'mil', 'mad', 'lis', 'bru', 'vie', 'zur', 'sto', 'osl', 'cph', 'hel', 'ice', 'ath', 'ist', 'lse', 'iob', 'dub', 'tae', 'jse', 'sau', 'dfm', 'adx', 'qse', 'tai', 'koe', 'hkg', 'shh', 'shz', 'bom', 'nse', 'asx', 'nze', 'sgx', 'kln', 'set', 'pse', 'jkt', 'vse', 'sao', 'mex', 'bue', 'sgo', 'col', 'lim', 'ccs', 'mte', 'wse', 'bud', 'pra', 'buh', 'mic', 'kse', 'cse', 'doh', 'bah', 'mus', 'cas', 'nig', 'gha', 'ken', 'uga', 'rwa', 'tzs', 'zim', 'bot', 'nam', 'mau', 'pal', 'amm', 'bei', 'dam', 'bag', 'teh', 'dse', 'hcm', 'hnx'
                  ],
                },
                description: 'Filter by exchange codes (e.g. ["nyq", "nms"]).',
              },
              percentChangeRange: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Filter by percent change range [min, max] (e.g. [-5, 5]).',
              },
              fiftyTwoWeekPercentChangeRange: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Filter by 52-week percent change range [min, max].',
              },
              intradayPriceRange: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Filter by intraday price range [min, max].',
              },
              eodPriceRange: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Filter by end-of-day price range [min, max].',
              },
              dayVolumeRange: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Filter by day volume range [min, max].',
              },
              intradayPriceChangeRange: {
                type: 'array',
                items: { type: 'number' },
                minItems: 2,
                maxItems: 2,
                description: 'Filter by intraday price change range [min, max].',
              },
              averageDailyVolume3mAbove: {
                type: 'number',
                description: 'Filter by 3-month average daily volume above this value.',
              },
              size: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                default: 25,
                description: 'Max records to return. Default 25, max 100.',
              },
              offset: {
                type: 'number',
                minimum: 0,
                default: 0,
                description: 'Offset for pagination. Default 0.',
              },
              sortField: {
                type: 'string',
                enum: [
                  'symbol', 'shortName', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'regularMarketVolume', 'averageDailyVolume3Month'
                ],
                default: 'regularMarketChangePercent',
                description: 'Field to sort by.',
              },
              sortOrder: {
                type: 'string',
                enum: ['asc', 'desc'],
                default: 'desc',
                description: 'Sort order (asc or desc). Default desc.',
              },
              fields: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: [
                    'symbol', 'shortName', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'regularMarketVolume', 'averageDailyVolume3Month', 'fiftyTwoWeekPercentChange', 'exchange', 'region'
                  ],
                },
                description: 'Specific fields to return in the records.',
              },
              provider: {
                type: 'string',
                default: 'yahoo',
                description: 'Optional provider override (e.g. "yahoo").',
              },
            },
            required: ['action', 'quoteType'],
            additionalProperties: false,
          },
          {
            properties: {
              action: { const: 'screen_securities' },
              quoteType: { const: 'EQUITY' },
            },
            required: ['action', 'quoteType'],
            oneOf: [
              {
                properties: {
                  fieldProfile: { const: 'standard' },
                  regions: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'us', 'ca', 'gb', 'fr', 'de', 'jp', 'hk', 'au', 'in', 'br', 'cn', 'kr', 'tw', 'ch', 'nl', 'se', 'es', 'it', 'sg', 'mx', 'za', 'ru', 'sa', 'tr', 'id', 'th', 'my', 'ph', 'vn', 'pl', 'be', 'at', 'fi', 'no', 'dk', 'ie', 'pt', 'gr', 'il', 'nz', 'co', 'cl', 'pe', 'ar', 'cz', 'hu', 'ro', 'ua', 'ae', 'qa'
                      ],
                    },
                    description: 'Filter by region/country codes (e.g. ["us", "ca"]).',
                  },
                  exchanges: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'nyq', 'nms', 'ams', 'par', 'ger', 'fra', 'stu', 'mun', 'ber', 'dus', 'ham', 'han', 'mil', 'mad', 'lis', 'bru', 'vie', 'zur', 'sto', 'osl', 'cph', 'hel', 'ice', 'ath', 'ist', 'lse', 'iob', 'dub', 'tae', 'jse', 'sau', 'dfm', 'adx', 'qse', 'tai', 'koe', 'hkg', 'shh', 'shz', 'bom', 'nse', 'asx', 'nze', 'sgx', 'kln', 'set', 'pse', 'jkt', 'vse', 'sao', 'mex', 'bue', 'sgo', 'col', 'lim', 'ccs', 'mte', 'wse', 'bud', 'pra', 'buh', 'mic', 'kse', 'cse', 'doh', 'bah', 'mus', 'cas', 'nig', 'gha', 'ken', 'uga', 'rwa', 'tzs', 'zim', 'bot', 'nam', 'mau', 'pal', 'amm', 'bei', 'dam', 'bag', 'teh', 'dse', 'hcm', 'hnx'
                      ],
                    },
                    description: 'Filter by exchange codes (e.g. ["nyq", "nms"]).',
                  },
                  sectors: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by sectors (e.g. ["Technology", "Healthcare"]).',
                  },
                  industries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by industries (e.g. ["Semiconductors", "Software"]).',
                  },
                  marketCapRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by market cap range [min, max] in USD.',
                  },
                  peRatioRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by PE ratio range [min, max].',
                  },
                  priceRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by price range [min, max] in USD.',
                  },
                  percentChangeRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by percent change range [min, max] (e.g. [-5, 5]).',
                  },
                  fiftyTwoWeekPercentChangeRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by 52-week percent change range [min, max].',
                  },
                  dayVolumeRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by day volume range [min, max].',
                  },
                  averageDailyVolume3MonthAbove: {
                    type: 'number',
                    description: 'Filter by 3-month average daily volume above this value.',
                  },
                  betaRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by beta range [min, max].',
                  },
                  dividendYieldRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by dividend yield range [min, max] as decimal percentage (e.g. [0.01, 0.05]).',
                  },
                  size: {
                    type: 'number',
                    minimum: 1,
                    maximum: 200,
                    default: 25,
                    description: 'Max records to return. Default 25, max 200.',
                  },
                  offset: {
                    type: 'number',
                    minimum: 0,
                    default: 0,
                    description: 'Offset for pagination. Default 0.',
                  },
                  sortField: {
                    type: 'string',
                    description: 'Field to sort by (e.g. "marketCap", "peRatioLtm", "regularMarketPrice"). Let Yahoo validate.',
                  },
                  sortOrder: {
                    type: 'string',
                    enum: ['asc', 'desc'],
                    default: 'desc',
                    description: 'Sort order (asc or desc). Default desc.',
                  },
                  fields: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'symbol', 'shortName', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'marketCap', 'peRatioLtm', 'regularMarketVolume', 'averageDailyVolume3Month', 'fiftyTwoWeekPercentChange', 'beta', 'dividendYield', 'sector', 'industry', 'exchange', 'region'
                      ],
                    },
                    description: 'Specific fields to return in the records.',
                  },
                  provider: {
                    type: 'string',
                    default: 'yahoo',
                    description: 'Optional provider override (e.g. "yahoo").',
                  },
                },
                required: ['fieldProfile'],
                additionalProperties: false,
              },
              {
                properties: {
                  fieldProfile: { const: 'ratios' },
                  regions: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'us', 'ca', 'gb', 'fr', 'de', 'jp', 'hk', 'au', 'in', 'br', 'cn', 'kr', 'tw', 'ch', 'nl', 'se', 'es', 'it', 'sg', 'mx', 'za', 'ru', 'sa', 'tr', 'id', 'th', 'my', 'ph', 'vn', 'pl', 'be', 'at', 'fi', 'no', 'dk', 'ie', 'pt', 'gr', 'il', 'nz', 'co', 'cl', 'pe', 'ar', 'cz', 'hu', 'ro', 'ua', 'ae', 'qa'
                      ],
                    },
                    description: 'Filter by region/country codes (e.g. ["us", "ca"]).',
                  },
                  exchanges: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'nyq', 'nms', 'ams', 'par', 'ger', 'fra', 'stu', 'mun', 'ber', 'dus', 'ham', 'han', 'mil', 'mad', 'lis', 'bru', 'vie', 'zur', 'sto', 'osl', 'cph', 'hel', 'ice', 'ath', 'ist', 'lse', 'iob', 'dub', 'tae', 'jse', 'sau', 'dfm', 'adx', 'qse', 'tai', 'koe', 'hkg', 'shh', 'shz', 'bom', 'nse', 'asx', 'nze', 'sgx', 'kln', 'set', 'pse', 'jkt', 'vse', 'sao', 'mex', 'bue', 'sgo', 'col', 'lim', 'ccs', 'mte', 'wse', 'bud', 'pra', 'buh', 'mic', 'kse', 'cse', 'doh', 'bah', 'mus', 'cas', 'nig', 'gha', 'ken', 'uga', 'rwa', 'tzs', 'zim', 'bot', 'nam', 'mau', 'pal', 'amm', 'bei', 'dam', 'bag', 'teh', 'dse', 'hcm', 'hnx'
                      ],
                    },
                    description: 'Filter by exchange codes (e.g. ["nyq", "nms"]).',
                  },
                  sectors: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by sectors (e.g. ["Technology", "Healthcare"]).',
                  },
                  industries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Filter by industries (e.g. ["Semiconductors", "Software"]).',
                  },
                  marketCapRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by market cap range [min, max] in USD.',
                  },
                  peRatioRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by PE ratio range [min, max].',
                  },
                  priceRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by price range [min, max] in USD.',
                  },
                  percentChangeRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by percent change range [min, max] (e.g. [-5, 5]).',
                  },
                  fiftyTwoWeekPercentChangeRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by 52-week percent change range [min, max].',
                  },
                  dayVolumeRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by day volume range [min, max].',
                  },
                  averageDailyVolume3MonthAbove: {
                    type: 'number',
                    description: 'Filter by 3-month average daily volume above this value.',
                  },
                  betaRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by beta range [min, max].',
                  },
                  dividendYieldRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by dividend yield range [min, max] as decimal percentage (e.g. [0.01, 0.05]).',
                  },
                  lastClosePriceBookValueRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by last close price to book value ratio range [min, max].',
                  },
                  pegRatio5YrRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by 5-year PEG ratio range [min, max].',
                  },
                  currentRatioRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by current ratio range [min, max].',
                  },
                  grossProfitMarginRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by gross profit margin range [min, max].',
                  },
                  returnOnAssetsRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by return on assets range [min, max].',
                  },
                  returnOnEquityRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by return on equity range [min, max].',
                  },
                  totalDebtEquityRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by total debt to equity ratio range [min, max].',
                  },
                  longTermDebtEquityRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by long term debt to equity ratio range [min, max].',
                  },
                  returnOnTotalCapitalRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by return on total capital range [min, max].',
                  },
                  netIncomeMarginRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by net income margin range [min, max].',
                  },
                  altmanZScoreRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by Altman Z-score range [min, max].',
                  },
                  quickRatioRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by quick ratio range [min, max].',
                  },
                  totalDebtEbitdaRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by total debt to EBITDA ratio range [min, max].',
                  },
                  ebitdaMarginRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by EBITDA margin range [min, max].',
                  },
                  netDebtEbitdaRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by net debt to EBITDA ratio range [min, max].',
                  },
                  epsGrowthRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by EPS growth range [min, max].',
                  },
                  forwardDividendYieldRange: {
                    type: 'array',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2,
                    description: 'Filter by forward dividend yield range [min, max].',
                  },
                  size: {
                    type: 'number',
                    minimum: 1,
                    maximum: 200,
                    default: 25,
                    description: 'Max records to return. Default 25, max 200.',
                  },
                  offset: {
                    type: 'number',
                    minimum: 0,
                    default: 0,
                    description: 'Offset for pagination. Default 0.',
                  },
                  sortField: {
                    type: 'string',
                    description: 'Field to sort by (e.g. "marketCap", "peRatioLtm", "regularMarketPrice"). Let Yahoo validate.',
                  },
                  sortOrder: {
                    type: 'string',
                    enum: ['asc', 'desc'],
                    default: 'desc',
                    description: 'Sort order (asc or desc). Default desc.',
                  },
                  fields: {
                    type: 'array',
                    items: {
                      type: 'string',
                      enum: [
                        'symbol', 'shortName', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'marketCap', 'peRatioLtm', 'regularMarketVolume', 'averageDailyVolume3Month', 'fiftyTwoWeekPercentChange', 'beta', 'dividendYield', 'sector', 'industry', 'exchange', 'region',
                        'lastClosePriceBookValueLtm', 'pegRatio5Yr', 'currentRatioLtm', 'grossProfitMarginPercentLtm', 'returnOnAssetsPercentLtm', 'returnOnEquityPercentLtm', 'totalDebtEquityPercentLtm', 'longTermDebtEquityPercentLtm', 'returnOnTotalCapitalLtm', 'netIncomeMarginPercentLtm', 'altmanZScoreLtm', 'quickRatioLtm', 'totalDebtEbitdaLtm', 'ebitdaMarginPercentLtm', 'netDebtEbitdaLtm', 'epsGrowthPercentLtm', 'forwardDividendYieldPercent'
                      ],
                    },
                    description: 'Specific fields to return in the records.',
                  },
                  provider: {
                    type: 'string',
                    default: 'yahoo',
                    description: 'Optional provider override (e.g. "yahoo").',
                  },
                },
                required: ['fieldProfile'],
                additionalProperties: false,
              }
            ],
          },
          {
            properties: {
              action: { const: 'screen_securities' },
              quoteType: { const: 'ETF' }
            },
            additionalProperties: true
          },
          {
            properties: {
              action: { const: 'screen_securities' },
              quoteType: { const: 'MUTUALFUND' }
            },
            additionalProperties: true
          }
        ],
      }
    ],
  },

  async execute(args: any, context?: any): Promise<any> {
    const action = args.action;
    if (!action) {
      throw new FinanceError({
        code: 'bad_request',
        message: 'Missing required parameter: action',
      });
    }

    const providerName = args.provider || 'yahoo';
    const provider = getProvider(providerName);
    const controller = new AbortController();
    const unsubscribe = context?.onCancel?.(() => controller.abort());
    const signal = controller.signal;

    // Action-specific validation
    if (action !== 'search_assets' && action !== 'screen_securities') {
      if (!args.symbol) {
        throw new FinanceError({
          code: 'bad_request',
          message: `Parameter 'symbol' is required for action '${action}'`,
        });
      }
    } else if (action === 'search_assets') {
      if (!args.query) {
        throw new FinanceError({
          code: 'bad_request',
          message: "Parameter 'query' is required for action 'search_assets'",
        });
      }
    } else if (action === 'screen_securities') {
      if (!args.quoteType) {
        throw new FinanceError({
          code: 'bad_request',
          message: "Parameter 'quoteType' is required for action 'screen_securities'",
        });
      }
    }

    try {
      try {
        switch (action) {
          case 'search_assets':
            return await provider.searchAssets(args, signal);
          case 'get_market_snapshot':
            return await provider.getMarketSnapshot(args, signal);
          case 'get_company_profile':
            return await provider.getCompanyProfile(args, signal);
          case 'get_historical_prices':
            return await provider.getHistoricalPrices(args, signal);
          case 'get_analyst_ratings':
            return await provider.getAnalystRatings(args, signal);
          case 'get_calendar_events':
            return await provider.getCalendarEvents(args, signal);
          case 'get_ownership':
            return await provider.getOwnership(args, signal);
          case 'get_financial_statements':
            if (!args.statement_type || !args.period_type) {
              throw new FinanceError({
                code: 'bad_request',
                message: "Parameters 'statement_type' and 'period_type' are required for action 'get_financial_statements'",
              });
            }
            return await provider.getFinancialStatements(args, signal);
          case 'screen_securities':
            if (args.quoteType === 'ETF') {
              throw new FinanceError({
                code: 'bad_request',
                message: 'ETF support is not available in screen_securities v2.0; planned for v2.1',
              });
            }
            if (args.quoteType === 'MUTUALFUND') {
              throw new FinanceError({
                code: 'bad_request',
                message: 'MUTUALFUND support is not available in screen_securities v2.0; planned for v2.2',
              });
            }
            return await provider.screenSecurities(args, signal);
          default:
            throw new FinanceError({
              code: 'bad_request',
              message: `Unknown action: ${action}`,
            });
        }
      } finally {
        unsubscribe?.();
      }
    } catch (err) {
      if (err instanceof FinanceError) {
        throw err;
      }
      throw new FinanceError({
        code: 'upstream_unavailable',
        message: err instanceof Error ? err.message : String(err),
        cause: err,
      });
    }
  },
};

export default financeTool;
