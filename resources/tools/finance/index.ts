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
        ],
      },
      symbol: {
        type: 'string',
        description: 'Ticker symbol (e.g. "AAPL", "BTC-USD", "^GSPC"). Required for all actions except search_assets.',
      },
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
        description: 'Cap on returned rows (historical_prices, ownership). Default varies by action.',
      },
      include_corporate_actions: {
        type: 'boolean',
        default: true,
        description: 'Include dividends and splits in the date range (historical_prices).',
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
      months_back: {
        type: 'number',
        minimum: 1,
        maximum: 60,
        default: 12,
        description: 'How many months back to retrieve analyst action history.',
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
    required: ['action'],
    oneOf: [
      {
        title: 'search_assets',
        type: 'object',
        properties: {
          action: { const: 'search_assets' },
          query: { type: 'string' },
          quote_type: { type: 'string' },
          exchange: { type: 'string' },
          sector: { type: 'string' },
          industry: { type: 'string' },
          limit: { type: 'number' },
          provider: { type: 'string' },
        },
        required: ['action', 'query'],
        additionalProperties: false,
      },
      {
        title: 'get_market_snapshot',
        type: 'object',
        properties: {
          action: { const: 'get_market_snapshot' },
          symbol: { type: 'string' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_company_profile',
        type: 'object',
        properties: {
          action: { const: 'get_company_profile' },
          symbol: { type: 'string' },
          include_officers: { type: 'boolean' },
          max_officers: { type: 'number' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_historical_prices',
        type: 'object',
        properties: {
          action: { const: 'get_historical_prices' },
          symbol: { type: 'string' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
          frequency: { type: 'string' },
          max_rows: { type: 'number' },
          include_corporate_actions: { type: 'boolean' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_analyst_ratings',
        type: 'object',
        properties: {
          action: { const: 'get_analyst_ratings' },
          symbol: { type: 'string' },
          months_back: { type: 'number' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_calendar_events',
        type: 'object',
        properties: {
          action: { const: 'get_calendar_events' },
          symbol: { type: 'string' },
          max_events: { type: 'number' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_ownership',
        type: 'object',
        properties: {
          action: { const: 'get_ownership' },
          symbol: { type: 'string' },
          max_rows: { type: 'number' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol'],
        additionalProperties: false,
      },
      {
        title: 'get_financial_statements',
        type: 'object',
        properties: {
          action: { const: 'get_financial_statements' },
          symbol: { type: 'string' },
          statement_type: { type: 'string' },
          period_type: { type: 'string' },
          max_periods: { type: 'number' },
          provider: { type: 'string' },
        },
        required: ['action', 'symbol', 'statement_type', 'period_type'],
        additionalProperties: false,
      },
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
    if (action !== 'search_assets') {
      if (!args.symbol) {
        throw new FinanceError({
          code: 'bad_request',
          message: `Parameter 'symbol' is required for action '${action}'`,
        });
      }
    } else {
      if (!args.query) {
        throw new FinanceError({
          code: 'bad_request',
          message: "Parameter 'query' is required for action 'search_assets'",
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
