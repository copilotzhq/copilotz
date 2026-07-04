export interface FinanceDataProvider {
  searchAssets(input: SearchAssetsInput, signal?: AbortSignal): Promise<SearchAssetsOutput>;
  getMarketSnapshot(input: GetMarketSnapshotInput, signal?: AbortSignal): Promise<MarketSnapshot>;
  getCompanyProfile(input: GetCompanyProfileInput, signal?: AbortSignal): Promise<CompanyProfile>;
  getHistoricalPrices(input: GetHistoricalPricesInput, signal?: AbortSignal): Promise<HistoricalPrices>;
  getAnalystRatings(input: GetAnalystRatingsInput, signal?: AbortSignal): Promise<AnalystRatings>;
  getCalendarEvents(input: GetCalendarEventsInput, signal?: AbortSignal): Promise<CalendarEvents>;
  getOwnership(input: GetOwnershipInput, signal?: AbortSignal): Promise<Ownership>;
  getFinancialStatements(input: GetFinancialStatementsInput, signal?: AbortSignal): Promise<FinancialStatements>;
  screenSecurities(input: ScreenSecuritiesInput, signal?: AbortSignal): Promise<ScreenSecuritiesOutput>;
}

// 4.1 Search Assets
export interface SearchAssetsInput {
  query: string;
  quote_type?: 'equity' | 'etf' | 'mutualfund' | 'index' | 'future' | 'currency' | 'cryptocurrency';
  exchange?: string;
  sector?: string;
  industry?: string;
  limit?: number;
}

export interface SearchAssetsOutput {
  query: string;
  total_results: number;
  returned: number;
  results: AssetSearchResult[];
}

export interface AssetSearchResult {
  symbol: string;
  short_name?: string;
  long_name?: string;
  exchange?: string;
  exchange_display?: string;
  quote_type?: string;
  sector?: string;
  sector_display?: string;
  industry?: string;
  industry_display?: string;
  score?: number;
  is_yahoo_finance?: boolean;
}

// 4.2 Market Snapshot
export interface GetMarketSnapshotInput {
  symbol: string;
  include?: ('price' | 'insights' | 'key_stats' | 'valuation' | 'profile_summary')[];
}

export interface MarketSnapshot {
  symbol: string;
  as_of: string;
  price?: PriceSnapshot;
  key_stats?: KeyStats;
  valuation?: ValuationMetrics;
  insights?: InsightsSnapshot;
  profile_summary?: ProfileSummary;
}

export interface PriceSnapshot {
  currency?: string;
  current_price?: number;
  previous_close?: number;
  day_high?: number;
  day_low?: number;
  year_high?: number;
  year_low?: number;
  open?: number;
  volume?: number;
  market_cap?: number;
}

export interface KeyStats {
  beta?: number;
  fifty_two_week_change?: number;
  sand_p_fifty_two_week_change?: number;
  dividend_yield?: number;
  dividend_rate?: number;
  trailing_eps?: number;
  forward_eps?: number;
  book_value?: number;
  price_to_book?: number;
  shares_outstanding?: number;
  float_shares?: number;
  held_percent_insiders?: number;
  held_percent_institutions?: number;
}

export interface ValuationMetrics {
  forward_pe?: number;
  trailing_pe?: number;
  price_to_sales?: number;
  enterprise_value?: number;
  enterprise_to_revenue?: number;
  enterprise_to_ebitda?: number;
}

export interface InsightsSnapshot {
  recommendation?: string;
  target_price?: number;
  technical_sentiment?: string;
}

export interface ProfileSummary {
  sector?: string;
  industry?: string;
  employees?: number;
  long_business_summary?: string;
}

// 4.3 Company Profile
export interface GetCompanyProfileInput {
  symbol: string;
  include_officers?: boolean;
  max_officers?: number;
}

export interface CompanyProfile {
  symbol: string;
  profile: AssetProfile;
  truncated: boolean;
}

export interface AssetProfile {
  long_name?: string;
  short_name?: string;
  sector?: string;
  industry?: string;
  country?: string;
  state?: string;
  city?: string;
  address1?: string;
  zip?: string;
  phone?: string;
  website?: string;
  description?: string;
  employees?: number;
  founded?: string;
  company_officers?: Officer[];
  audit_risk?: number;
  board_risk?: number;
  compensation_risk?: number;
  shareholder_rights_risk?: number;
  overall_risk?: number;
  governance_score?: number;
  environment_score?: number;
  social_score?: number;
  controversy_level?: number;
}

export interface Officer {
  name?: string;
  title?: string;
  age?: number;
  year_born?: number;
  total_pay?: number;
  exercised_value?: number;
  unexercised_value?: number;
}

// 4.4 Historical Prices
export interface GetHistoricalPricesInput {
  symbol: string;
  start_date?: string;
  end_date?: string;
  frequency: 'daily' | 'monthly';
  max_rows?: number;
  include_corporate_actions?: boolean;
}

export interface HistoricalPrices {
  symbol: string;
  frequency: 'daily' | 'monthly';
  currency?: string;
  start_date?: string;
  end_date?: string;
  bars: PriceBar[];
  corporate_actions?: CorporateAction[];
  truncated: boolean;
  total_rows_available: number;
}

export interface PriceBar {
  date: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  adj_close?: number;
  volume?: number;
}

export interface CorporateAction {
  date: string;
  type: 'dividend' | 'split';
  amount?: number;
  ratio?: string;
}

// 4.5 Analyst Ratings
export interface GetAnalystRatingsInput {
  symbol: string;
  months_back?: number;
}

export interface AnalystRatings {
  symbol: string;
  recommendation_trend: RecommendationTrendEntry[];
  recent_changes: AnalystAction[];
  target_price?: TargetPrice;
  consensus?: ConsensusSummary;
}

export interface RecommendationTrendEntry {
  period: string;
  strong_buy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strong_sell?: number;
}

export interface AnalystAction {
  date: string;
  firm?: string;
  action: 'up' | 'down' | 'main' | 'init' | 'reiter';
  from_grade?: string;
  to_grade?: string;
  epoch_grade_date?: string;
}

export interface TargetPrice {
  current?: number;
  high?: number;
  low?: number;
  mean?: number;
  median?: number;
}

export interface ConsensusSummary {
  mean_rating?: string;
  mean_rating_value?: number;
  total_analysts?: number;
}

// 4.6 Calendar Events
export interface GetCalendarEventsInput {
  symbol: string;
  include?: ('earnings' | 'dividends')[];
  max_events?: number;
}

export interface CalendarEvents {
  symbol: string;
  earnings?: EarningsEvent[];
  dividends?: DividendEvent[];
  truncated: boolean;
}

export interface EarningsEvent {
  date: string;
  eps_estimate?: number;
  eps_actual?: number;
  revenue_estimate?: number;
  revenue_actual?: number;
  time_of_day?: 'BMO' | 'AMC' | 'DMT' | '';
}

export interface DividendEvent {
  ex_date: string;
  pay_date?: string;
  record_date?: string;
  declaration_date?: string;
  amount?: number;
  currency?: string;
}

// 4.7 Ownership
export interface GetOwnershipInput {
  symbol: string;
  include?: ('institutions' | 'funds' | 'insiders' | 'major_holders' | 'insider_transactions')[];
  max_rows?: number;
}

export interface Ownership {
  symbol: string;
  institutions?: InstitutionHolder[];
  funds?: FundHolder[];
  insiders?: InsiderHolder[];
  major_holders_breakdown?: MajorHoldersBreakdown;
  insider_transactions?: InsiderTransaction[];
  truncated: boolean;
}

export interface InstitutionHolder {
  holder?: string;
  shares?: number;
  date_reported?: string;
  pct_held?: number;
  value?: number;
}

export interface FundHolder {
  holder?: string;
  shares?: number;
  date_reported?: string;
  pct_held?: number;
  value?: number;
}

export interface InsiderHolder {
  holder?: string;
  shares?: number;
  date_reported?: string;
  pct_held?: number;
  value?: number;
}

export interface MajorHoldersBreakdown {
  insiders_pct?: number;
  institutions_pct?: number;
  institutions_float_pct?: number;
  institutions_count?: number;
}

export interface InsiderTransaction {
  insider?: string;
  position?: string;
  date?: string;
  transaction_type?: string;
  shares?: number;
  value?: number;
}

// 4.8 Financial Statements
export interface GetFinancialStatementsInput {
  symbol: string;
  statement_type: 'income_statement' | 'balance_sheet' | 'cash_flow' | 'key_stats';
  period_type: 'annual' | 'quarterly' | 'trailing';
  max_periods?: number;
}

export interface FinancialStatements {
  symbol: string;
  statement_type: 'income_statement' | 'balance_sheet' | 'cash_flow' | 'key_stats';
  period_type: 'annual' | 'quarterly' | 'trailing';
  periods: FinancialPeriod[];
  coverage: {
    available: string[];
    missing: string[];
    warnings?: string[];
  };
  truncated: boolean;
}

export interface FinancialPeriod {
  period_end_date: string;
  [metric: string]: any;
}


// 4.9 Screen Securities


export interface ScreenSecuritiesIndexInput {
  action: 'screen_securities';
  quoteType: 'INDEX';
  regions?: string[];
  exchanges?: string[];
  percentChangeRange?: [number, number];
  fiftyTwoWeekPercentChangeRange?: [number, number];
  intradayPriceRange?: [number, number];
  eodPriceRange?: [number, number];
  dayVolumeRange?: [number, number];
  intradayPriceChangeRange?: [number, number];
  averageDailyVolume3mAbove?: number;
  size?: number;
  offset?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  fields?: string[];
  provider?: string;
}

export type ScreenSecuritiesInput = ScreenSecuritiesIndexInput | ScreenSecuritiesEquityInput | ScreenSecuritiesEtfInput | ScreenSecuritiesMutualFundInput;

export interface ScreenSecuritiesEtfInput {
  action: 'screen_securities';
  quoteType: 'ETF';
  [key: string]: any;
}

export interface ScreenSecuritiesMutualFundInput {
  action: 'screen_securities';
  quoteType: 'MUTUALFUND';
  [key: string]: any;
}

export type ScreenSecuritiesEquityInput = ScreenSecuritiesEquityStandardInput | ScreenSecuritiesEquityRatiosInput | ScreenSecuritiesEquityFinancialsInput;

export interface ScreenSecuritiesEquityStandardInput {
  action: 'screen_securities';
  quoteType: 'EQUITY';
  fieldProfile: 'standard';
  regions?: string[];
  exchanges?: string[];
  sectors?: string[];
  industries?: string[];
  marketCapRange?: [number, number];
  peRatioRange?: [number, number];
  priceRange?: [number, number];
  percentChangeRange?: [number, number];
  fiftyTwoWeekPercentChangeRange?: [number, number];
  dayVolumeRange?: [number, number];
  averageDailyVolume3MonthAbove?: number;
  betaRange?: [number, number];
  dividendYieldRange?: [number, number];
  size?: number;
  offset?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  fields?: string[];
  provider?: string;
}

export interface ScreenSecuritiesEquityRatiosInput {
  action: 'screen_securities';
  quoteType: 'EQUITY';
  fieldProfile: 'ratios';
  regions?: string[];
  exchanges?: string[];
  sectors?: string[];
  industries?: string[];
  marketCapRange?: [number, number];
  peRatioRange?: [number, number];
  priceRange?: [number, number];
  percentChangeRange?: [number, number];
  fiftyTwoWeekPercentChangeRange?: [number, number];
  dayVolumeRange?: [number, number];
  averageDailyVolume3MonthAbove?: number;
  betaRange?: [number, number];
  dividendYieldRange?: [number, number];
  // New ratio range filters:
  lastClosePriceBookValueRange?: [number, number];
  pegRatio5YrRange?: [number, number];
  currentRatioRange?: [number, number];
  grossProfitMarginRange?: [number, number];
  returnOnAssetsRange?: [number, number];
  returnOnEquityRange?: [number, number];
  totalDebtEquityRange?: [number, number];
  longTermDebtEquityRange?: [number, number];
  returnOnTotalCapitalRange?: [number, number];
  netIncomeMarginRange?: [number, number];
  altmanZScoreRange?: [number, number];
  quickRatioRange?: [number, number];
  totalDebtEbitdaRange?: [number, number];
  ebitdaMarginRange?: [number, number];
  netDebtEbitdaRange?: [number, number];
  epsGrowthRange?: [number, number];
  forwardDividendYieldRange?: [number, number];
  size?: number;
  offset?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  fields?: string[];
  provider?: string;
}

export interface ScreenSecuritiesEquityFinancialsInput {
  action: 'screen_securities';
  quoteType: 'EQUITY';
  fieldProfile: 'financials';
  regions?: string[];
  exchanges?: string[];
  sectors?: string[];
  industries?: string[];
  marketCapRange?: [number, number];
  priceRange?: [number, number];
  percentChangeRange?: [number, number];
  fiftyTwoWeekPercentChangeRange?: [number, number];
  dayVolumeRange?: [number, number];
  averageDailyVolume3MonthAbove?: number;
  operatingCashFlowToCurrentLiabilitiesRange?: [number, number];
  ebitdaInterestExpenseRange?: [number, number];
  ebitInterestExpenseRange?: [number, number];
  totalRevenue1YrGrowthRange?: [number, number];
  netIncome1YrGrowthRange?: [number, number];
  basicEpsContinuingOperationsRange?: [number, number];
  revenueGrowthPercentYoYQuarterlyRange?: [number, number];
  totalRevenueRange?: [number, number];
  totalRevenueAnnualMarketCurrencyRange?: [number, number];
  totalRevenuePerEmployeeAnnualMarketCurrencyRange?: [number, number];
  netEpsBasicRange?: [number, number];
  ebitda1YrGrowthRange?: [number, number];
  dilutedEps1YrGrowthRange?: [number, number];
  netEpsDilutedRange?: [number, number];
  netIncomeIsRange?: [number, number];
  netIncomeIsAnnualMarketCurrencyRange?: [number, number];
  netIncomePerEmployeeAnnualMarketCurrencyRange?: [number, number];
  operatingIncomeRange?: [number, number];
  grossProfitRange?: [number, number];
  ebitdaRange?: [number, number];
  dilutedEpsContinuingOperationsRange?: [number, number];
  ebitRange?: [number, number];
  forwardDividendYieldRange?: [number, number];
  size?: number;
  offset?: number;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  fields?: string[];
  provider?: string;
}

export interface ScreenSecuritiesOutput {
  records: Record<string, any>[];
  totalCount: number;
  nextOffset: number | null;
}
