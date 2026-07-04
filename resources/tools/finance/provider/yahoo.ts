import { FinanceDataProvider, SearchAssetsInput, SearchAssetsOutput, MarketSnapshot, GetMarketSnapshotInput, CompanyProfile, GetCompanyProfileInput, HistoricalPrices, GetHistoricalPricesInput, PriceBar, CorporateAction, AnalystRatings, GetAnalystRatingsInput, CalendarEvents, GetCalendarEventsInput, EarningsEvent, DividendEvent, Ownership, GetOwnershipInput, InstitutionHolder, FundHolder, InsiderHolder, MajorHoldersBreakdown, InsiderTransaction, FinancialStatements, GetFinancialStatementsInput, FinancialPeriod, ScreenSecuritiesInput, ScreenSecuritiesOutput } from './types.ts';
import { acquireCookieAndCrumb, doYahooRequest, doAuthenticatedYahooRequest } from '../client/yahoo-client.ts';
import { FinanceError } from '../client/errors.ts';

async function fetchQuoteSummary<T>(
  symbol: string,
  modules: string[],
  signal?: AbortSignal
): Promise<T> {
  const url = new URL(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}`
  );
  url.searchParams.set('modules', modules.join(','));
  return await doAuthenticatedYahooRequest<T>(url.toString(), { signal });
}

export class YahooProvider implements FinanceDataProvider {
  async searchAssets(input: SearchAssetsInput, signal?: AbortSignal): Promise<SearchAssetsOutput> {
    const limit = input.limit ?? 10;
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(input.query)}&quotesCount=${limit}&newsCount=0&listsCount=0&quotesQueryId=tss_match_phrase_query`;
    
    const data = await doYahooRequest<any>(url, undefined, { signal });
    const rawResults = data?.quotes || [];
    
    let results = rawResults.map((q: any) => ({
      symbol: q.symbol,
      short_name: q.shortname,
      long_name: q.longname,
      exchange: q.exchange,
      exchange_display: q.exchDisp,
      quote_type: q.quoteType,
      sector: q.sector,
      sector_display: q.sectorDisp,
      industry: q.industry,
      industry_display: q.industryDisp,
      score: q.score,
      is_yahoo_finance: q.isYahooFinance,
    }));

    if (input.quote_type) {
      results = results.filter((r: any) => r.quote_type?.toLowerCase() === input.quote_type?.toLowerCase());
    }
    if (input.exchange) {
      results = results.filter((r: any) => r.exchange?.toLowerCase() === input.exchange?.toLowerCase());
    }
    if (input.sector) {
      results = results.filter((r: any) => r.sector?.toLowerCase() === input.sector?.toLowerCase());
    }
    if (input.industry) {
      results = results.filter((r: any) => r.industry?.toLowerCase() === input.industry?.toLowerCase());
    }

    return {
      query: input.query,
      total_results: rawResults.length,
      returned: results.length,
      results: results.slice(0, limit),
    };
  }

  async getMarketSnapshot(input: GetMarketSnapshotInput, signal?: AbortSignal): Promise<MarketSnapshot> {
    const include = input.include || ['price', 'key_stats', 'valuation'];
    const modules: string[] = [];
    if (include.includes('price')) modules.push('price');
    if (include.includes('key_stats')) modules.push('defaultKeyStatistics');
    if (include.includes('valuation')) modules.push('financialData');
    if (include.includes('insights')) modules.push('earningsTrend');
    if (include.includes('profile_summary')) modules.push('summaryProfile');

    const data = await fetchQuoteSummary<any>(input.symbol, modules, signal);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      throw new FinanceError({
        code: 'not_found',
        message: `Symbol not found: ${input.symbol}`,
        symbol: input.symbol,
      });
    }

    const snapshot: MarketSnapshot = {
      symbol: input.symbol,
      as_of: new Date().toISOString(),
    };

    if (include.includes('price') && result.price) {
      const p = result.price;
      snapshot.price = {
        currency: p.currency,
        current_price: p.regularMarketPrice?.raw,
        previous_close: p.regularMarketPreviousClose?.raw,
        day_high: p.regularMarketDayHigh?.raw,
        day_low: p.regularMarketDayLow?.raw,
        year_high: p.fiftyTwoWeekHigh?.raw,
        year_low: p.fiftyTwoWeekLow?.raw,
        open: p.regularMarketOpen?.raw,
        volume: p.regularMarketVolume?.raw,
        market_cap: p.marketCap?.raw,
      };
    }

    if (include.includes('key_stats') && result.defaultKeyStatistics) {
      const k = result.defaultKeyStatistics;
      snapshot.key_stats = {
        beta: k.beta?.raw,
        fifty_two_week_change: k['52WeekChange']?.raw,
        sand_p_fifty_two_week_change: k.SandP52WeekChange?.raw,
        dividend_yield: k.dividendYield?.raw,
        dividend_rate: k.dividendRate?.raw,
        trailing_eps: k.trailingEps?.raw,
        forward_eps: k.forwardEps?.raw,
        book_value: k.bookValue?.raw,
        price_to_book: k.priceToBook?.raw,
        shares_outstanding: k.sharesOutstanding?.raw,
        float_shares: k.floatShares?.raw,
        held_percent_insiders: k.heldPercentInsiders?.raw,
        held_percent_institutions: k.heldPercentInstitutions?.raw,
      };
    }

    if (include.includes('valuation') && result.financialData) {
      const fd = result.financialData;
      const k = result.defaultKeyStatistics || {};
      snapshot.valuation = {
        forward_pe: k.forwardPE?.raw,
        trailing_pe: k.trailingPE?.raw,
        price_to_sales: k.priceToSales?.raw,
        enterprise_value: k.enterpriseValue?.raw,
        enterprise_to_revenue: k.enterpriseToRevenue?.raw,
        enterprise_to_ebitda: k.enterpriseToEbitda?.raw,
      };
    }

    if (include.includes('insights') && result.earningsTrend) {
      const et = result.earningsTrend?.trend?.[0] || {};
      snapshot.insights = {
        recommendation: result.financialData?.recommendationKey,
        target_price: result.financialData?.targetMeanPrice?.raw,
        technical_sentiment: undefined, // Yahoo doesn't expose technical sentiment directly in quoteSummary
      };
    }

    if (include.includes('profile_summary') && result.summaryProfile) {
      const sp = result.summaryProfile;
      snapshot.profile_summary = {
        sector: sp.sector,
        industry: sp.industry,
        employees: sp.fullTimeEmployees,
        long_business_summary: sp.longBusinessSummary,
      };
    }

    return snapshot;
  }

  async getCompanyProfile(input: GetCompanyProfileInput, signal?: AbortSignal): Promise<CompanyProfile> {
    const modules = ['assetProfile', 'summaryProfile'];
    const data = await fetchQuoteSummary<any>(input.symbol, modules, signal);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      throw new FinanceError({
        code: 'not_found',
        message: `Symbol not found: ${input.symbol}`,
        symbol: input.symbol,
      });
    }

    const ap = result.assetProfile || {};
    const sp = result.summaryProfile || {};

    let officers = ap.companyOfficers || [];
    const totalOfficers = officers.length;
    const maxOfficers = input.max_officers ?? 5;
    let truncated = false;
    if (input.include_officers) {
      if (officers.length > maxOfficers) {
        officers = officers.slice(0, maxOfficers);
        truncated = true;
      }
      officers = officers.map((o: any) => ({
        name: o.name,
        title: o.title,
        age: o.age,
        year_born: o.yearBorn,
        total_pay: o.totalPay?.raw,
        exercised_value: o.exercisedValue?.raw,
        unexercised_value: o.unexercisedValue?.raw,
      }));
    } else {
      officers = undefined;
    }

    return {
      symbol: input.symbol,
      profile: {
        long_name: sp.longName || ap.longName,
        short_name: sp.shortName || ap.shortName,
        sector: ap.sector || sp.sector,
        industry: ap.industry || sp.industry,
        country: ap.country,
        state: ap.state,
        city: ap.city,
        address1: ap.address1,
        zip: ap.zip,
        phone: ap.phone,
        website: ap.website || sp.website,
        description: ap.longBusinessSummary || sp.longBusinessSummary,
        employees: ap.fullTimeEmployees || sp.fullTimeEmployees,
        founded: undefined,
        company_officers: officers,
        audit_risk: ap.auditRisk,
        board_risk: ap.boardRisk,
        compensation_risk: ap.compensationRisk,
        shareholder_rights_risk: ap.shareHolderRightsRisk,
        overall_risk: ap.overallRisk,
        governance_score: ap.governanceScore,
        environment_score: ap.environmentScore,
        social_score: ap.socialScore,
        controversy_level: ap.highestControversyLevel,
      },
      truncated,
    };
  }

  async getHistoricalPrices(input: GetHistoricalPricesInput, signal?: AbortSignal): Promise<HistoricalPrices> {
    const frequency = input.frequency;
    if (frequency !== 'daily' && frequency !== 'monthly') {
      throw new FinanceError({
        code: 'bad_request',
        message: `Unsupported frequency: ${frequency}. Only 'daily' and 'monthly' are supported.`,
      });
    }

    const interval = frequency === 'daily' ? '1d' : '1mo';
    const nowSec = Math.floor(Date.now() / 1000);
    const oneYearAgoSec = nowSec - 365 * 24 * 60 * 60;

    const p1 = input.start_date ? Math.floor(new Date(input.start_date).getTime() / 1000) : oneYearAgoSec;
    const p2 = input.end_date ? Math.floor(new Date(input.end_date).getTime() / 1000) : nowSec;

    const events = input.include_corporate_actions !== false ? 'div|split' : '';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(input.symbol)}?period1=${p1}&period2=${p2}&interval=${interval}&events=${events}`;
    
    const data = await doYahooRequest<any>(url, undefined, { signal });
    const result = data?.chart?.result?.[0];
    if (!result) {
      throw new FinanceError({
        code: 'not_found',
        message: `Symbol not found: ${input.symbol}`,
        symbol: input.symbol,
      });
    }

    const timestamps = result.timestamp || [];
    const indicators = result.indicators?.quote?.[0] || {};
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose || [];

    let bars: PriceBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const dateStr = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
      bars.push({
        date: dateStr,
        open: indicators.open?.[i],
        high: indicators.high?.[i],
        low: indicators.low?.[i],
        close: indicators.close?.[i],
        adj_close: adjClose[i],
        volume: indicators.volume?.[i],
      });
    }

    const totalRowsAvailable = bars.length;
    const maxRows = input.max_rows ?? 1000;
    let truncated = false;
    if (bars.length > maxRows) {
      bars = bars.slice(0, maxRows);
      truncated = true;
    }

    let corporateActions: CorporateAction[] = [];
    if (input.include_corporate_actions !== false && result.events) {
      if (result.events.dividends) {
        for (const [ts, div] of Object.entries(result.events.dividends)) {
          const dateStr = new Date(Number(ts) * 1000).toISOString().split('T')[0];
          corporateActions.push({
            date: dateStr,
            type: 'dividend',
            amount: (div as any).amount,
          });
        }
      }
      if (result.events.splits) {
        for (const [ts, split] of Object.entries(result.events.splits)) {
          const dateStr = new Date(Number(ts) * 1000).toISOString().split('T')[0];
          corporateActions.push({
            date: dateStr,
            type: 'split',
            ratio: (split as any).splitRatio,
          });
        }
      }
      corporateActions.sort((a, b) => a.date.localeCompare(b.date));
    }

    return {
      symbol: input.symbol,
      frequency,
      currency: result.meta?.currency,
      start_date: input.start_date || new Date(oneYearAgoSec * 1000).toISOString().split('T')[0],
      end_date: input.end_date || new Date(nowSec * 1000).toISOString().split('T')[0],
      bars,
      corporate_actions: corporateActions.length > 0 ? corporateActions : undefined,
      truncated,
      total_rows_available: totalRowsAvailable,
    };
  }

  async getAnalystRatings(input: GetAnalystRatingsInput, signal?: AbortSignal): Promise<AnalystRatings> {
    const modules = ['recommendationTrend', 'upgradeDowngradeHistory', 'financialData'];
    const data = await fetchQuoteSummary<any>(input.symbol, modules, signal);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      throw new FinanceError({
        code: 'not_found',
        message: `Symbol not found: ${input.symbol}`,
        symbol: input.symbol,
      });
    }

    const rt = result.recommendationTrend?.trend || [];
    const ugh = result.upgradeDowngradeHistory?.history || [];
    const fd = result.financialData || {};

    const recommendationTrend = rt.map((t: any) => ({
      period: t.period,
      strong_buy: t.strongBuy,
      buy: t.buy,
      hold: t.hold,
      sell: t.sell,
      strong_sell: t.strongSell,
    }));

    const monthsBack = input.months_back ?? 12;
    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthsBack);

    const recentChanges = ugh
      .filter((h: any) => {
        const d = new Date(h.epochGradeDate * 1000);
        return d >= cutoffDate;
      })
      .map((h: any) => ({
        date: new Date(h.epochGradeDate * 1000).toISOString().split('T')[0],
        firm: h.financialAdvisor,
        action: h.action === 'up' || h.action === 'down' || h.action === 'main' || h.action === 'init' || h.action === 'reiter' ? h.action : 'main',
        from_grade: h.fromGrade,
        to_grade: h.toGrade,
        epoch_grade_date: new Date(h.epochGradeDate * 1000).toISOString(),
      }));

    return {
      symbol: input.symbol,
      recommendation_trend: recommendationTrend,
      recent_changes: recentChanges,
      target_price: {
        current: fd.currentPrice?.raw,
        high: fd.targetHighPrice?.raw,
        low: fd.targetLowPrice?.raw,
        mean: fd.targetMeanPrice?.raw,
        median: fd.targetMedianPrice?.raw,
      },
      consensus: {
        mean_rating: fd.recommendationKey,
        mean_rating_value: fd.recommendationMean?.raw,
        total_analysts: fd.numberOfAnalystOpinions?.raw,
      },
    };
  }

  async getCalendarEvents(input: GetCalendarEventsInput, signal?: AbortSignal): Promise<CalendarEvents> {
    const include = input.include || ['earnings', 'dividends'];
    const maxEvents = input.max_events ?? 20;
    let truncated = false;

    let earnings: EarningsEvent[] = [];
    let dividends: DividendEvent[] = [];

    if (include.includes('earnings')) {
      const data = await fetchQuoteSummary<any>(input.symbol, ['calendarEvents'], signal);
      const result = data?.quoteSummary?.result?.[0];
      const ce = result?.calendarEvents?.earnings;
      if (ce && ce.earningsDate) {
        earnings = ce.earningsDate.map((d: any) => ({
          date: new Date(d.raw * 1000).toISOString().split('T')[0],
          eps_estimate: ce.earningsAverage?.raw,
          eps_actual: undefined,
          revenue_estimate: undefined,
          revenue_actual: undefined,
          time_of_day: undefined,
        }));
      }
    }

    if (include.includes('dividends')) {
      const nowSec = Math.floor(Date.now() / 1000);
      const oneYearAgoSec = nowSec - 365 * 24 * 60 * 60;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(input.symbol)}?period1=${oneYearAgoSec}&period2=${nowSec}&interval=1mo&events=div`;
      const data = await doYahooRequest<any>(url, undefined, { signal });
      const result = data?.chart?.result?.[0];
      if (result?.events?.dividends) {
        for (const [ts, div] of Object.entries(result.events.dividends)) {
          dividends.push({
            ex_date: new Date(Number(ts) * 1000).toISOString().split('T')[0],
            amount: (div as any).amount,
          });
        }
        dividends.sort((a, b) => b.ex_date.localeCompare(a.ex_date));
      }
    }

    if (earnings.length > maxEvents) {
      earnings = earnings.slice(0, maxEvents);
      truncated = true;
    }
    if (dividends.length > maxEvents) {
      dividends = dividends.slice(0, maxEvents);
      truncated = true;
    }

    return {
      symbol: input.symbol,
      earnings: include.includes('earnings') ? earnings : undefined,
      dividends: include.includes('dividends') ? dividends : undefined,
      truncated,
    };
  }

  async getOwnership(input: GetOwnershipInput, signal?: AbortSignal): Promise<Ownership> {
    const include = input.include || ['institutions', 'insiders'];
    const maxRows = input.max_rows ?? 50;
    let truncated = false;

    const modules: string[] = [];
    if (include.includes('institutions')) modules.push('institutionOwnership');
    if (include.includes('funds')) modules.push('fundOwnership');
    if (include.includes('insiders')) modules.push('insiderHolders');
    if (include.includes('major_holders')) modules.push('majorHoldersBreakdown');
    if (include.includes('insider_transactions')) modules.push('insiderTransactions');

    const data = await fetchQuoteSummary<any>(input.symbol, modules, signal);
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      throw new FinanceError({
        code: 'not_found',
        message: `Symbol not found: ${input.symbol}`,
        symbol: input.symbol,
      });
    }

    let institutions: InstitutionHolder[] | undefined;
    let funds: FundHolder[] | undefined;
    let insiders: InsiderHolder[] | undefined;
    let major_holders_breakdown: MajorHoldersBreakdown | undefined;
    let insider_transactions: InsiderTransaction[] | undefined;

    if (include.includes('institutions') && result.institutionOwnership) {
      let list = result.institutionOwnership.ownershipList || [];
      if (list.length > maxRows) {
        list = list.slice(0, maxRows);
        truncated = true;
      }
      institutions = list.map((o: any) => ({
        holder: o.organization,
        shares: o.position?.raw,
        date_reported: o.reportDate?.fmt,
        pct_held: o.pctHeld?.raw,
        value: o.value?.raw,
      }));
    }

    if (include.includes('funds') && result.fundOwnership) {
      let list = result.fundOwnership.ownershipList || [];
      if (list.length > maxRows) {
        list = list.slice(0, maxRows);
        truncated = true;
      }
      funds = list.map((o: any) => ({
        holder: o.organization,
        shares: o.position?.raw,
        date_reported: o.reportDate?.fmt,
        pct_held: o.pctHeld?.raw,
        value: o.value?.raw,
      }));
    }

    if (include.includes('insiders') && result.insiderHolders) {
      let list = result.insiderHolders.holders || [];
      if (list.length > maxRows) {
        list = list.slice(0, maxRows);
        truncated = true;
      }
      insiders = list.map((o: any) => ({
        holder: o.name,
        shares: o.position?.raw,
        date_reported: o.latestTransDate?.fmt,
        pct_held: o.positionDirectPercent?.raw,
        value: undefined,
      }));
    }

    if (include.includes('major_holders') && result.majorHoldersBreakdown) {
      const m = result.majorHoldersBreakdown;
      major_holders_breakdown = {
        insiders_pct: m.insidersPercent?.raw,
        institutions_pct: m.institutionsPercent?.raw,
        institutions_float_pct: m.institutionsFloatPercent?.raw,
        institutions_count: m.institutionsCount?.raw,
      };
    }

    if (include.includes('insider_transactions') && result.insiderTransactions) {
      let list = result.insiderTransactions.transactions || [];
      if (list.length > maxRows) {
        list = list.slice(0, maxRows);
        truncated = true;
      }
      insider_transactions = list.map((o: any) => ({
        insider: o.filerName,
        position: o.filerRelation,
        date: o.startDate?.fmt,
        transaction_type: o.transactionText,
        shares: o.shares?.raw,
        value: o.value?.raw,
      }));
    }

    return {
      symbol: input.symbol,
      institutions,
      funds,
      insiders,
      major_holders_breakdown,
      insider_transactions,
      truncated,
    };
  }

  async getFinancialStatements(input: GetFinancialStatementsInput, signal?: AbortSignal): Promise<FinancialStatements> {
    const { symbol, statement_type, period_type } = input;
    const maxPeriods = input.max_periods ?? 5;

    // 1. Acquire cookie and crumb statelessly
    const { cookie, crumb } = await acquireCookieAndCrumb({ signal });

    // 2. Map statement_type to Yahoo module keys
    const statementKeys: Record<string, string[]> = {
      income_statement: [
        'TaxEffectOfUnusualItems','TaxRateForCalcs','NormalizedEBITDA','NormalizedDilutedEPS','NormalizedBasicEPS','TotalUnusualItems','TotalUnusualItemsExcludingGoodwill','NetIncomeFromContinuingOperationNetMinorityInterest','ReconciledDepreciation','ReconciledCostOfRevenue','EBITDA','EBIT','NetInterestIncome','InterestExpense','InterestIncome','NormalizedIncome','NetIncomeFromContinuingAndDiscontinuedOperation','TotalExpenses','TotalOperatingIncomeAsReported','DilutedAverageShares','BasicAverageShares','DilutedEPS','BasicEPS','DilutedNIAvailtoComStockholders','NetIncomeCommonStockholders','NetIncome','NetIncomeIncludingNoncontrollingInterests','NetIncomeContinuousOperations','TaxProvision','PretaxIncome','OtherNonOperatingIncomeExpenses','SpecialIncomeCharges','NetNonOperatingInterestIncomeExpense','InterestExpenseNonOperating','InterestIncomeNonOperating','OperatingIncome','OperatingExpense','ResearchAndDevelopment','SellingGeneralAndAdministration','GrossProfit','CostOfRevenue','TotalRevenue','OperatingRevenue'
      ],
      balance_sheet: [
        'OrdinarySharesNumber','ShareholderEquity','TotalEquityGrossMinorityInterest','StockholdersEquity','RetainedEarnings','AdditionalPaidInCapital','CommonStock','TotalDebt','NetDebt','LongTermDebt','LongTermDebtAndCapitalLeaseObligations','CurrentDebtAndCapitalLeaseObligations','CurrentDebt','OtherNonCurrentLiabilities','LongTermProvisions','LongTermDebt','NonCurrentDeferredLiabilities','NonCurrentDeferredTaxesLiabilities','NonCurrentLiabilities','CurrentLiabilities','OtherCurrentLiabilities','CurrentDeferredLiabilities','CurrentDeferredTaxesLiabilities','CurrentProvisions','CurrentDebt','PayablesAndAccruedExpenses','Payables','AccountsPayable','TotalAssets','OtherNonCurrentAssets','NonCurrentDeferredAssets','NonCurrentDeferredTaxesAssets','NetPPE','GoodwillAndOtherIntangibleAssets','Goodwill','OtherIntangibleAssets','CurrentAssets','OtherCurrentAssets','Inventory','Receivables','AccountsReceivable','CashCashEquivalentsAndShortTermInvestments','CashAndCashEquivalents'
      ],
      cash_flow: [
        'FreeCashFlow','RepurchaseOfCapitalStock','RepaymentOfDebt','IssuanceOfDebt','IssuanceOfCapitalStock','CapitalExpenditure','EndCashPosition','BeginningCashPosition','ChangesInCash','FinancingCashFlow','InvestingCashFlow','OperatingCashFlow','StockBasedCompensation','DeferredTax','DeferredIncomeTax','DepreciationAmortizationDepletion','DepreciationAndAmortization','Depreciation','NetIncomeFromContinuingOperations'
      ],
      key_stats: [
        'MarketCap','EnterpriseValue','TrailingPE','ForwardPE','PriceToSales','PriceToBook','EVToRevenue','EVToEBITDA','Beta','FiftyTwoWeekHigh','FiftyTwoWeekLow'
      ]
    };

    const keys = statementKeys[statement_type];
    if (!keys) {
      throw new FinanceError({
        code: 'bad_request',
        message: `Unsupported statement type: ${statement_type}`,
      });
    }

    // 3. Construct request types with period prefix
    const prefix = period_type === 'annual' ? 'annual' : period_type === 'quarterly' ? 'quarterly' : 'trailing';
    const reqTypes = keys.map(k => `${prefix}${k}`);

    // 4. Fetch from Yahoo fundamentals-timeseries endpoint
    const nowSec = Math.floor(Date.now() / 1000);
    const tenYearsAgoSec = nowSec - 10 * 365 * 24 * 60 * 60;
    const p1 = period_type === 'annual' ? '1325376000' : '1577836800'; // match probe
    const p2 = String(nowSec);

    // Chunk requests to keep URLs short and safe
    const chunkSize = 20;
    let allResults: any[] = [];
    const warnings: string[] = [];

    for (let i = 0; i < reqTypes.length; i += chunkSize) {
      const chunk = reqTypes.slice(i, i + chunkSize);
      const qs = `symbol=${encodeURIComponent(symbol)}&type=${encodeURIComponent(chunk.join(','))}&period1=${p1}&period2=${p2}&crumb=${encodeURIComponent(crumb)}`;
      const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?${qs}`;
      
      try {
        const r = await doYahooRequest<any>(url, cookie, { signal });
        const result = r?.timeseries?.result;
        if (Array.isArray(result)) {
          allResults = allResults.concat(result);
        }
        if (r?.timeseries?.error) {
          warnings.push(`api_error:${JSON.stringify(r.timeseries.error)}`);
        }
      } catch (err) {
        warnings.push(`request_failed:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 5. Normalize flat metric-series slices into structured statement objects
    const periodsMap: Record<string, FinancialPeriod> = {};
    const availableMetrics = new Set<string>();
    const missingMetrics = new Set<string>(keys);

    for (const item of allResults) {
      const meta = item?.meta;
      const typeKey = meta?.type?.[0];
      if (!typeKey) continue;

      // Strip prefix to get normalized metric name
      const normalizedMetric = typeKey.startsWith(prefix) ? typeKey.slice(prefix.length) : typeKey;
      
      // Map back to our keys
      const originalKey = keys.find(k => k.toLowerCase() === normalizedMetric.toLowerCase());
      if (!originalKey) continue;

      const series = item[typeKey];
      if (Array.isArray(series)) {
        availableMetrics.add(originalKey);
        missingMetrics.delete(originalKey);

        for (const dataPoint of series) {
          const dateStr = dataPoint?.asOfDate;
          const val = dataPoint?.reportedValue?.raw;
          if (!dateStr || val === undefined) continue;

          if (!periodsMap[dateStr]) {
            periodsMap[dateStr] = { period_end_date: dateStr };
          }
          // Map to camel_case or snake_case as required by SPEC
          const snakeMetric = originalKey.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
          periodsMap[dateStr][snakeMetric] = val;
        }
      }
    }

    // Sort periods descending
    let periods = Object.values(periodsMap).sort((a, b) => b.period_end_date.localeCompare(a.period_end_date));
    const totalPeriods = periods.length;
    let truncated = false;
    if (periods.length > maxPeriods) {
      periods = periods.slice(0, maxPeriods);
      truncated = true;
    }

    return {
      symbol,
      statement_type,
      period_type,
      periods,
      coverage: {
        available: Array.from(availableMetrics),
        missing: Array.from(missingMetrics),
        warnings: warnings.length > 0 ? warnings : undefined,
      },
      truncated,
    };
  }

  async screenSecurities(input: ScreenSecuritiesInput, signal?: AbortSignal): Promise<ScreenSecuritiesOutput> {
    const quoteType = input.quoteType || 'INDEX';
    const size = input.size ?? 25;
    const offset = input.offset ?? 0;

    // 1. Local validation
    const maxSize = quoteType === 'EQUITY' ? 200 : 100;
    if (size < 1 || size > maxSize) {
      throw new FinanceError({
        code: 'bad_request',
        message: `Parameter 'size' must be between 1 and ${maxSize}. Got ${size}`,
      });
    }
    if (offset < 0) {
      throw new FinanceError({
        code: 'bad_request',
        message: `Parameter 'offset' must be non-negative. Got ${offset}`,
      });
    }

    // Validate ranges
    const validateRange = (field: string, range?: [number, number]) => {
      if (!range) return;
      if (!Array.isArray(range)) {
        throw new FinanceError({
          code: 'bad_request',
          message: `Invalid range format for '${field}': expected [min, max] array.`,
        });
      }
      const [min, max] = range;
      if (min > max) {
        throw new FinanceError({
          code: 'bad_request',
          message: `Invalid range for '${field}': min (${min}) cannot be greater than max (${max})`,
        });
      }
    };

    if (quoteType === 'INDEX') {
      const idxInput = input as any;
      validateRange('percentChangeRange', idxInput.percentChangeRange);
      validateRange('fiftyTwoWeekPercentChangeRange', idxInput.fiftyTwoWeekPercentChangeRange);
      validateRange('intradayPriceRange', idxInput.intradayPriceRange);
      validateRange('eodPriceRange', idxInput.eodPriceRange);
      validateRange('dayVolumeRange', idxInput.dayVolumeRange);
      validateRange('intradayPriceChangeRange', idxInput.intradayPriceChangeRange);
    } else if (quoteType === 'EQUITY') {
      const eqInput = input as any;
      validateRange('marketCapRange', eqInput.marketCapRange);
      validateRange('peRatioRange', eqInput.peRatioRange);
      validateRange('priceRange', eqInput.priceRange);
      validateRange('percentChangeRange', eqInput.percentChangeRange);
      validateRange('fiftyTwoWeekPercentChangeRange', eqInput.fiftyTwoWeekPercentChangeRange);
      validateRange('dayVolumeRange', eqInput.dayVolumeRange);
      validateRange('betaRange', eqInput.betaRange);
      validateRange('dividendYieldRange', eqInput.dividendYieldRange);
      validateRange('lastClosePriceBookValueRange', eqInput.lastClosePriceBookValueRange);
      validateRange('pegRatio5YrRange', eqInput.pegRatio5YrRange);
      validateRange('currentRatioRange', eqInput.currentRatioRange);
      validateRange('grossProfitMarginRange', eqInput.grossProfitMarginRange);
      validateRange('returnOnAssetsRange', eqInput.returnOnAssetsRange);
      validateRange('returnOnEquityRange', eqInput.returnOnEquityRange);
      validateRange('totalDebtEquityRange', eqInput.totalDebtEquityRange);
      validateRange('longTermDebtEquityRange', eqInput.longTermDebtEquityRange);
      validateRange('returnOnTotalCapitalRange', eqInput.returnOnTotalCapitalRange);
      validateRange('netIncomeMarginRange', eqInput.netIncomeMarginRange);
      validateRange('altmanZScoreRange', eqInput.altmanZScoreRange);
      validateRange('quickRatioRange', eqInput.quickRatioRange);
      validateRange('totalDebtEbitdaRange', eqInput.totalDebtEbitdaRange);
      validateRange('ebitdaMarginRange', eqInput.ebitdaMarginRange);
      validateRange('netDebtEbitdaRange', eqInput.netDebtEbitdaRange);
      validateRange('epsGrowthRange', eqInput.epsGrowthRange);
      validateRange('forwardDividendYieldRange', eqInput.forwardDividendYieldRange);
      validateRange('operatingCashFlowToCurrentLiabilitiesRange', eqInput.operatingCashFlowToCurrentLiabilitiesRange);
      validateRange('ebitdaInterestExpenseRange', eqInput.ebitdaInterestExpenseRange);
      validateRange('ebitInterestExpenseRange', eqInput.ebitInterestExpenseRange);
      validateRange('totalRevenue1YrGrowthRange', eqInput.totalRevenue1YrGrowthRange);
      validateRange('netIncome1YrGrowthRange', eqInput.netIncome1YrGrowthRange);
      validateRange('basicEpsContinuingOperationsRange', eqInput.basicEpsContinuingOperationsRange);
      validateRange('revenueGrowthPercentYoYQuarterlyRange', eqInput.revenueGrowthPercentYoYQuarterlyRange);
      validateRange('totalRevenueRange', eqInput.totalRevenueRange);
      validateRange('totalRevenueAnnualMarketCurrencyRange', eqInput.totalRevenueAnnualMarketCurrencyRange);
      validateRange('totalRevenuePerEmployeeAnnualMarketCurrencyRange', eqInput.totalRevenuePerEmployeeAnnualMarketCurrencyRange);
      validateRange('netEpsBasicRange', eqInput.netEpsBasicRange);
      validateRange('ebitda1YrGrowthRange', eqInput.ebitda1YrGrowthRange);
      validateRange('dilutedEps1YrGrowthRange', eqInput.dilutedEps1YrGrowthRange);
      validateRange('netEpsDilutedRange', eqInput.netEpsDilutedRange);
      validateRange('netIncomeIsRange', eqInput.netIncomeIsRange);
      validateRange('netIncomeIsAnnualMarketCurrencyRange', eqInput.netIncomeIsAnnualMarketCurrencyRange);
      validateRange('netIncomePerEmployeeAnnualMarketCurrencyRange', eqInput.netIncomePerEmployeeAnnualMarketCurrencyRange);
      validateRange('operatingIncomeRange', eqInput.operatingIncomeRange);
      validateRange('grossProfitRange', eqInput.grossProfitRange);
      validateRange('ebitdaRange', eqInput.ebitdaRange);
      validateRange('dilutedEpsContinuingOperationsRange', eqInput.dilutedEpsContinuingOperationsRange);
      validateRange('ebitRange', eqInput.ebitRange);
    }

    // 2. Sort field mapping
    const sortField = input.sortField ?? (quoteType === 'INDEX' ? 'regularMarketChangePercent' : 'marketCap');
    const sortOrder = (input.sortOrder ?? 'desc').toUpperCase();

    const INDEX_SORT_MAP: Record<string, string> = {
      symbol: 'ticker',
      shortName: 'companyshortname',
      regularMarketPrice: 'intradayprice',
      regularMarketChange: 'intradaypricechange',
      regularMarketChangePercent: 'percentchange',
      regularMarketVolume: 'dayvolume',
      averageDailyVolume3Month: 'avgdailyvol3m',
    };

    const EQUITY_FIELD_MAP: Record<string, string> = {
      symbol: 'ticker',
      shortName: 'companyshortname',
      regularMarketPrice: 'intradayprice',
      regularMarketChange: 'intradaypricechange',
      regularMarketChangePercent: 'percentchange',
      marketCap: 'intradaymarketcap',
      peRatioLtm: 'peratio.lasttwelvemonths',
      regularMarketVolume: 'dayvolume',
      averageDailyVolume3Month: 'avgdailyvol3m',
      fiftyTwoWeekPercentChange: 'fiftytwowkpercentchange',
      beta: 'beta',
      dividendYield: 'dividendyield',
      sector: 'sector',
      industry: 'industry',
      exchange: 'exchange',
      region: 'region',
      lastClosePriceBookValueLtm: 'lastclosepricebookvalue.lasttwelvemonths',
      pegRatio5Yr: 'pegratio_5y',
      currentRatioLtm: 'currentratio.lasttwelvemonths',
      grossProfitMarginPercentLtm: 'grossprofitmargin.lasttwelvemonths',
      returnOnAssetsPercentLtm: 'returnonassets.lasttwelvemonths',
      returnOnEquityPercentLtm: 'returnonequity.lasttwelvemonths',
      totalDebtEquityPercentLtm: 'totaldebtequity.lasttwelvemonths',
      longTermDebtEquityPercentLtm: 'ltdebtequity.lasttwelvemonths',
      returnOnTotalCapitalLtm: 'returnontotalcapital.lasttwelvemonths',
      netIncomeMarginPercentLtm: 'netincomemargin.lasttwelvemonths',
      altmanZScoreLtm: 'altmanzscoreusingtheaveragestockinformationforaperiod.lasttwelvemonths',
      quickRatioLtm: 'quickratio.lasttwelvemonths',
      totalDebtEbitdaLtm: 'totaldebtebitda.lasttwelvemonths',
      ebitdaMarginPercentLtm: 'ebitdamargin.lasttwelvemonths',
      netDebtEbitdaLtm: 'netdebtebitda.lasttwelvemonths',
      epsGrowthPercentLtm: 'epsgrowth.lasttwelvemonths',
      forwardDividendYieldPercent: 'forward_dividend_yield',
      operatingCashFlowToCurrentLiabilitiesLtm: 'operatingcashflowtocurrentliabilities.lasttwelvemonths',
      ebitdaInterestExpenseLtm: 'ebitdainterestexpense.lasttwelvemonths',
      ebitInterestExpenseLtm: 'ebitinterestexpense.lasttwelvemonths',
      totalRevenue1YrGrowthPercentLtm: 'totalrevenues1yrgrowth.lasttwelvemonths',
      netIncome1YrGrowthPercentLtm: 'netincome1yrgrowth.lasttwelvemonths',
      basicEpsContinuingOperationsLtm: 'basicepscontinuingoperations.lasttwelvemonths',
      revenueGrowthPercentYoYQuarterly: 'quarterlyrevenuegrowth.quarterly',
      totalRevenueLtm: 'totalrevenues.lasttwelvemonths',
      totalRevenueAnnualMarketCurrency: 'total_revenue_market_currency.annual',
      totalRevenuePerEmployeeAnnualMarketCurrency: 'total_revenue_per_employee_annual_market_currency',
      netEpsBasicLtm: 'netepsbasic.lasttwelvemonths',
      ebitda1YrGrowthPercentLtm: 'ebitda1yrgrowth.lasttwelvemonths',
      dilutedEps1YrGrowthPercentLtm: 'dilutedeps1yrgrowth.lasttwelvemonths',
      netEpsDilutedLtm: 'netepsdiluted.lasttwelvemonths',
      netIncomeIsLtm: 'netincomeis.lasttwelvemonths',
      netIncomeIsAnnualMarketCurrency: 'netincomeismarketcurrency.annual',
      netIncomePerEmployeeAnnualMarketCurrency: 'net_income_per_employee_annual_market_currency',
      operatingIncomeLtm: 'operatingincome.lasttwelvemonths',
      grossProfitLtm: 'grossprofit.lasttwelvemonths',
      ebitdaLtm: 'ebitda.lasttwelvemonths',
      dilutedEpsContinuingOperationsLtm: 'dilutedepscontinuingoperations.lasttwelvemonths',
      ebitLtm: 'ebit.lasttwelvemonths',
    };

    let yahooSortField = sortField;
    if (quoteType === 'INDEX') {
      yahooSortField = INDEX_SORT_MAP[sortField];
      if (!yahooSortField) {
        throw new FinanceError({
          code: 'bad_request',
          message: `Unsupported sortField: '${sortField}'. Supported fields: ${Object.keys(INDEX_SORT_MAP).join(', ')}`,
        });
      }
    } else if (quoteType === 'EQUITY') {
      yahooSortField = EQUITY_FIELD_MAP[sortField] || sortField;
    }

    // 3. Build AST
    const operands: any[] = [];

    const buildCategorical = (field: string, values?: string[]) => {
      if (!values || values.length === 0) return null;
      if (values.length === 1) {
        return { operator: 'eq', operands: [field, values[0]] };
      }
      return {
        operator: 'or',
        operands: values.map(v => ({ operator: 'eq', operands: [field, v] })),
      };
    };

    const buildRange = (field: string, range?: [number, number]) => {
      if (!range) return null;
      if (!Array.isArray(range)) {
        throw new FinanceError({
          code: 'bad_request',
          message: `Invalid range format for '${field}': expected [min, max] array.`,
        });
      }
      const [min, max] = range;
      if (min === max) {
        return { operator: 'eq', operands: [field, min] };
      }
      return { operator: 'btwn', operands: [field, min, max] };
    };

    if (quoteType === 'INDEX') {
      const idxInput = input as any;
      const regionNode = buildCategorical('region', idxInput.regions);
      if (regionNode) operands.push(regionNode);

      const exchangeNode = buildCategorical('exchange', idxInput.exchanges);
      if (exchangeNode) operands.push(exchangeNode);

      const pctChangeNode = buildRange('percentchange', idxInput.percentChangeRange);
      if (pctChangeNode) operands.push(pctChangeNode);

      const fiftyTwoWeekPctChangeNode = buildRange('fiftytwowkpercentchange', idxInput.fiftyTwoWeekPercentChangeRange);
      if (fiftyTwoWeekPctChangeNode) operands.push(fiftyTwoWeekPctChangeNode);

      const intradayPriceNode = buildRange('intradayprice', idxInput.intradayPriceRange);
      if (intradayPriceNode) operands.push(intradayPriceNode);

      const eodPriceNode = buildRange('eodprice', idxInput.eodPriceRange);
      if (eodPriceNode) operands.push(eodPriceNode);

      const dayVolumeNode = buildRange('dayvolume', idxInput.dayVolumeRange);
      if (dayVolumeNode) operands.push(dayVolumeNode);

      const intradayPriceChangeNode = buildRange('intradaypricechange', idxInput.intradayPriceChangeRange);
      if (intradayPriceChangeNode) operands.push(intradayPriceChangeNode);

      if (idxInput.averageDailyVolume3mAbove !== undefined) {
        operands.push({
          operator: 'gt',
          operands: ['avgdailyvol3m', idxInput.averageDailyVolume3mAbove],
        });
      }
    } else if (quoteType === 'EQUITY') {
      const eqInput = input as any;
      const regionNode = buildCategorical('region', eqInput.regions);
      if (regionNode) operands.push(regionNode);

      const exchangeNode = buildCategorical('exchange', eqInput.exchanges);
      if (exchangeNode) operands.push(exchangeNode);

      const sectorNode = buildCategorical('sector', eqInput.sectors);
      if (sectorNode) operands.push(sectorNode);

      const industryNode = buildCategorical('industry', eqInput.industries);
      if (industryNode) operands.push(industryNode);

      const marketCapNode = buildRange('intradaymarketcap', eqInput.marketCapRange);
      if (marketCapNode) operands.push(marketCapNode);

      const peRatioNode = buildRange('peratio.lasttwelvemonths', eqInput.peRatioRange);
      if (peRatioNode) operands.push(peRatioNode);

      const priceNode = buildRange('intradayprice', eqInput.priceRange);
      if (priceNode) operands.push(priceNode);

      const pctChangeNode = buildRange('percentchange', eqInput.percentChangeRange);
      if (pctChangeNode) operands.push(pctChangeNode);

      const fiftyTwoWeekPctChangeNode = buildRange('fiftytwowkpercentchange', eqInput.fiftyTwoWeekPercentChangeRange);
      if (fiftyTwoWeekPctChangeNode) operands.push(fiftyTwoWeekPctChangeNode);

      const dayVolumeNode = buildRange('dayvolume', eqInput.dayVolumeRange);
      if (dayVolumeNode) operands.push(dayVolumeNode);

      if (eqInput.averageDailyVolume3MonthAbove !== undefined) {
        operands.push({
          operator: 'gt',
          operands: ['avgdailyvol3m', eqInput.averageDailyVolume3MonthAbove],
        });
      }

      const betaNode = buildRange('beta', eqInput.betaRange);
      if (betaNode) operands.push(betaNode);

      const divYieldNode = buildRange('dividendyield', eqInput.dividendYieldRange);
      if (divYieldNode) operands.push(divYieldNode);

      const lastClosePriceBookValueNode = buildRange('lastclosepricebookvalue.lasttwelvemonths', eqInput.lastClosePriceBookValueRange);
      if (lastClosePriceBookValueNode) operands.push(lastClosePriceBookValueNode);

      const pegRatio5YrNode = buildRange('pegratio_5y', eqInput.pegRatio5YrRange);
      if (pegRatio5YrNode) operands.push(pegRatio5YrNode);

      const currentRatioNode = buildRange('currentratio.lasttwelvemonths', eqInput.currentRatioRange);
      if (currentRatioNode) operands.push(currentRatioNode);

      const grossProfitMarginNode = buildRange('grossprofitmargin.lasttwelvemonths', eqInput.grossProfitMarginRange);
      if (grossProfitMarginNode) operands.push(grossProfitMarginNode);

      const returnOnAssetsNode = buildRange('returnonassets.lasttwelvemonths', eqInput.returnOnAssetsRange);
      if (returnOnAssetsNode) operands.push(returnOnAssetsNode);

      const returnOnEquityNode = buildRange('returnonequity.lasttwelvemonths', eqInput.returnOnEquityRange);
      if (returnOnEquityNode) operands.push(returnOnEquityNode);

      const totalDebtEquityNode = buildRange('totaldebtequity.lasttwelvemonths', eqInput.totalDebtEquityRange);
      if (totalDebtEquityNode) operands.push(totalDebtEquityNode);

      const longTermDebtEquityNode = buildRange('ltdebtequity.lasttwelvemonths', eqInput.longTermDebtEquityRange);
      if (longTermDebtEquityNode) operands.push(longTermDebtEquityNode);

      const returnOnTotalCapitalNode = buildRange('returnontotalcapital.lasttwelvemonths', eqInput.returnOnTotalCapitalRange);
      if (returnOnTotalCapitalNode) operands.push(returnOnTotalCapitalNode);

      const netIncomeMarginNode = buildRange('netincomemargin.lasttwelvemonths', eqInput.netIncomeMarginRange);
      if (netIncomeMarginNode) operands.push(netIncomeMarginNode);

      const altmanZScoreNode = buildRange('altmanzscoreusingtheaveragestockinformationforaperiod.lasttwelvemonths', eqInput.altmanZScoreRange);
      if (altmanZScoreNode) operands.push(altmanZScoreNode);

      const quickRatioNode = buildRange('quickratio.lasttwelvemonths', eqInput.quickRatioRange);
      if (quickRatioNode) operands.push(quickRatioNode);

      const totalDebtEbitdaNode = buildRange('totaldebtebitda.lasttwelvemonths', eqInput.totalDebtEbitdaRange);
      if (totalDebtEbitdaNode) operands.push(totalDebtEbitdaNode);

      const ebitdaMarginNode = buildRange('ebitdamargin.lasttwelvemonths', eqInput.ebitdaMarginRange);
      if (ebitdaMarginNode) operands.push(ebitdaMarginNode);

      const netDebtEbitdaNode = buildRange('netdebtebitda.lasttwelvemonths', eqInput.netDebtEbitdaRange);
      if (netDebtEbitdaNode) operands.push(netDebtEbitdaNode);

      const epsGrowthNode = buildRange('epsgrowth.lasttwelvemonths', eqInput.epsGrowthRange);
      if (epsGrowthNode) operands.push(epsGrowthNode);

      const forwardDividendYieldNode = buildRange('forward_dividend_yield', eqInput.forwardDividendYieldRange);
      if (forwardDividendYieldNode) operands.push(forwardDividendYieldNode);
      const operatingCashFlowToCurrentLiabilitiesLtmNode = buildRange('operatingcashflowtocurrentliabilities.lasttwelvemonths', eqInput.operatingCashFlowToCurrentLiabilitiesRange);
      if (operatingCashFlowToCurrentLiabilitiesLtmNode) operands.push(operatingCashFlowToCurrentLiabilitiesLtmNode);
      const ebitdaInterestExpenseLtmNode = buildRange('ebitdainterestexpense.lasttwelvemonths', eqInput.ebitdaInterestExpenseRange);
      if (ebitdaInterestExpenseLtmNode) operands.push(ebitdaInterestExpenseLtmNode);
      const ebitInterestExpenseLtmNode = buildRange('ebitinterestexpense.lasttwelvemonths', eqInput.ebitInterestExpenseRange);
      if (ebitInterestExpenseLtmNode) operands.push(ebitInterestExpenseLtmNode);
      const totalRevenue1YrGrowthPercentLtmNode = buildRange('totalrevenues1yrgrowth.lasttwelvemonths', eqInput.totalRevenue1YrGrowthRange);
      if (totalRevenue1YrGrowthPercentLtmNode) operands.push(totalRevenue1YrGrowthPercentLtmNode);
      const netIncome1YrGrowthPercentLtmNode = buildRange('netincome1yrgrowth.lasttwelvemonths', eqInput.netIncome1YrGrowthRange);
      if (netIncome1YrGrowthPercentLtmNode) operands.push(netIncome1YrGrowthPercentLtmNode);
      const basicEpsContinuingOperationsLtmNode = buildRange('basicepscontinuingoperations.lasttwelvemonths', eqInput.basicEpsContinuingOperationsRange);
      if (basicEpsContinuingOperationsLtmNode) operands.push(basicEpsContinuingOperationsLtmNode);
      const revenueGrowthPercentYoYQuarterlyNode = buildRange('quarterlyrevenuegrowth.quarterly', eqInput.revenueGrowthPercentYoYQuarterlyRange);
      if (revenueGrowthPercentYoYQuarterlyNode) operands.push(revenueGrowthPercentYoYQuarterlyNode);
      const totalRevenueLtmNode = buildRange('totalrevenues.lasttwelvemonths', eqInput.totalRevenueRange);
      if (totalRevenueLtmNode) operands.push(totalRevenueLtmNode);
      const totalRevenueAnnualMarketCurrencyNode = buildRange('total_revenue_market_currency.annual', eqInput.totalRevenueAnnualMarketCurrencyRange);
      if (totalRevenueAnnualMarketCurrencyNode) operands.push(totalRevenueAnnualMarketCurrencyNode);
      const totalRevenuePerEmployeeAnnualMarketCurrencyNode = buildRange('total_revenue_per_employee_annual_market_currency', eqInput.totalRevenuePerEmployeeAnnualMarketCurrencyRange);
      if (totalRevenuePerEmployeeAnnualMarketCurrencyNode) operands.push(totalRevenuePerEmployeeAnnualMarketCurrencyNode);
      const netEpsBasicLtmNode = buildRange('netepsbasic.lasttwelvemonths', eqInput.netEpsBasicRange);
      if (netEpsBasicLtmNode) operands.push(netEpsBasicLtmNode);
      const ebitda1YrGrowthPercentLtmNode = buildRange('ebitda1yrgrowth.lasttwelvemonths', eqInput.ebitda1YrGrowthRange);
      if (ebitda1YrGrowthPercentLtmNode) operands.push(ebitda1YrGrowthPercentLtmNode);
      const dilutedEps1YrGrowthPercentLtmNode = buildRange('dilutedeps1yrgrowth.lasttwelvemonths', eqInput.dilutedEps1YrGrowthRange);
      if (dilutedEps1YrGrowthPercentLtmNode) operands.push(dilutedEps1YrGrowthPercentLtmNode);
      const netEpsDilutedLtmNode = buildRange('netepsdiluted.lasttwelvemonths', eqInput.netEpsDilutedRange);
      if (netEpsDilutedLtmNode) operands.push(netEpsDilutedLtmNode);
      const netIncomeIsLtmNode = buildRange('netincomeis.lasttwelvemonths', eqInput.netIncomeIsRange);
      if (netIncomeIsLtmNode) operands.push(netIncomeIsLtmNode);
      const netIncomeIsAnnualMarketCurrencyNode = buildRange('netincomeismarketcurrency.annual', eqInput.netIncomeIsAnnualMarketCurrencyRange);
      if (netIncomeIsAnnualMarketCurrencyNode) operands.push(netIncomeIsAnnualMarketCurrencyNode);
      const netIncomePerEmployeeAnnualMarketCurrencyNode = buildRange('net_income_per_employee_annual_market_currency', eqInput.netIncomePerEmployeeAnnualMarketCurrencyRange);
      if (netIncomePerEmployeeAnnualMarketCurrencyNode) operands.push(netIncomePerEmployeeAnnualMarketCurrencyNode);
      const operatingIncomeLtmNode = buildRange('operatingincome.lasttwelvemonths', eqInput.operatingIncomeRange);
      if (operatingIncomeLtmNode) operands.push(operatingIncomeLtmNode);
      const grossProfitLtmNode = buildRange('grossprofit.lasttwelvemonths', eqInput.grossProfitRange);
      if (grossProfitLtmNode) operands.push(grossProfitLtmNode);
      const ebitdaLtmNode = buildRange('ebitda.lasttwelvemonths', eqInput.ebitdaRange);
      if (ebitdaLtmNode) operands.push(ebitdaLtmNode);
      const dilutedEpsContinuingOperationsLtmNode = buildRange('dilutedepscontinuingoperations.lasttwelvemonths', eqInput.dilutedEpsContinuingOperationsRange);
      if (dilutedEpsContinuingOperationsLtmNode) operands.push(dilutedEpsContinuingOperationsLtmNode);
      const ebitLtmNode = buildRange('ebit.lasttwelvemonths', eqInput.ebitRange);
      if (ebitLtmNode) operands.push(ebitLtmNode);
    }

    // Complexity check
    if (operands.length > 20) {
      throw new FinanceError({
        code: 'bad_request',
        message: `Query complexity limit exceeded: maximum of 20 top-level filter groups allowed. Got ${operands.length}.`,
      });
    }

    // 4. Map requested fields to Yahoo internal fields
    const defaultFields = quoteType === 'INDEX'
      ? ['symbol', 'shortName', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'exchange', 'region']
      : ['symbol', 'shortName', 'regularMarketPrice', 'regularMarketChange', 'regularMarketChangePercent', 'marketCap', 'peRatioLtm', 'sector', 'exchange'];

    const requestedFields = input.fields && input.fields.length > 0
      ? input.fields
      : defaultFields;

    const includeFields = Array.from(new Set(
      requestedFields.map((f: string) => {
        if (quoteType === 'INDEX') {
          const INDEX_FIELD_MAP: Record<string, string> = {
            symbol: 'ticker',
            shortName: 'companyshortname',
            regularMarketPrice: 'intradayprice',
            regularMarketChange: 'intradaypricechange',
            regularMarketChangePercent: 'percentchange',
            regularMarketVolume: 'dayvolume',
            averageDailyVolume3Month: 'avgdailyvol3m',
            fiftyTwoWeekPercentChange: 'fiftytwowkpercentchange',
            exchange: 'exchange',
            region: 'region',
          };
          return INDEX_FIELD_MAP[f] || f;
        } else {
          return EQUITY_FIELD_MAP[f] || f;
        }
      })
    ));

    // 5. Construct request body
    const body: Record<string, any> = {
      size,
      offset,
      sortType: sortOrder,
      sortField: yahooSortField,
      includeFields,
      topOperator: 'AND',
      quoteType,
    };

    if (operands.length === 0) {
      operands.push({
        operator: 'gt',
        operands: ['intradayprice', 0],
      });
    }

    if (operands.length > 0) {
      body.query = {
        operator: 'and',
        operands,
      };
    }

    // 6. Execute request
    const { cookie, crumb } = await acquireCookieAndCrumb({ signal });
    const url = new URL('https://query1.finance.yahoo.com/v1/finance/screener');
    url.searchParams.set('formatted', 'true');
    url.searchParams.set('useRecordsResponse', 'true');
    url.searchParams.set('lang', 'en-US');
    url.searchParams.set('region', 'US');
    url.searchParams.set('crumb', crumb);

    const res = await doYahooRequest<any>(url.toString(), cookie, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    const result0 = res?.finance?.result?.[0];
    const rawRecords = result0?.records || [];
    const totalCount = result0?.total ?? result0?.count ?? 0;

    // 7. Map records back to requested fields
    const records = rawRecords.map((raw: any) => {
      const mapped: Record<string, any> = {};
      
      const getVal = (v: any) => {
        if (v && typeof v === 'object' && 'raw' in v) {
          return v.raw;
        }
        return v;
      };

      const lookup = (keys: string[]) => {
        for (const k of keys) {
          if (raw[k] !== undefined) return getVal(raw[k]);
        }
        return undefined;
      };

      for (const field of requestedFields) {
        switch (field) {
          case 'symbol':
            mapped.symbol = lookup(['ticker', 'symbol']);
            break;
          case 'shortName':
            mapped.shortName = lookup(['companyName', 'companyshortname', 'shortName', 'shortname']);
            break;
          case 'regularMarketPrice':
            mapped.regularMarketPrice = lookup(['regularMarketPrice', 'intradayprice', 'price']);
            break;
          case 'regularMarketChange':
            mapped.regularMarketChange = lookup(['regularMarketChange', 'intradaypricechange', 'change']);
            break;
          case 'regularMarketChangePercent':
            mapped.regularMarketChangePercent = lookup(['regularMarketChangePercent', 'percentchange', 'changePercent']);
            break;
          case 'regularMarketVolume':
            mapped.regularMarketVolume = lookup(['regularMarketVolume', 'dayvolume', 'volume']);
            break;
          case 'averageDailyVolume3Month':
            mapped.averageDailyVolume3Month = lookup(['avgDailyVol3m', 'avgdailyvol3m', 'averageDailyVolume3Month']);
            break;
          case 'fiftyTwoWeekPercentChange':
            mapped.fiftyTwoWeekPercentChange = lookup(['fiftyTwoWeekChangePercent', 'fiftytwowkpercentchange']);
            break;
          case 'marketCap':
            mapped.marketCap = lookup(['marketCap', 'intradaymarketcap', 'marketcap']);
            break;
          case 'peRatioLtm':
            mapped.peRatioLtm = lookup(['peRatioLtm', 'peratio.lasttwelvemonths', 'peRatio']);
            break;
          case 'beta':
            mapped.beta = lookup(['beta']);
            break;
          case 'dividendYield':
            mapped.dividendYield = lookup(['dividendYield', 'dividendyield', 'dividendYieldPercent']);
            break;
          case 'lastClosePriceBookValueLtm':
            mapped.lastClosePriceBookValueLtm = lookup(['lastClosePriceBookValueLtm', 'lastclosepricebookvalueltm']);
            break;
          case 'pegRatio5Yr':
            mapped.pegRatio5Yr = lookup(['pegRatio5Yr', 'pegratio5yr']);
            break;
          case 'currentRatioLtm':
            mapped.currentRatioLtm = lookup(['currentRatioLtm', 'currentratioltm']);
            break;
          case 'grossProfitMarginPercentLtm':
            mapped.grossProfitMarginPercentLtm = lookup(['grossProfitMarginPercentLtm', 'grossprofitmarginpercentltm']);
            break;
          case 'returnOnAssetsPercentLtm':
            mapped.returnOnAssetsPercentLtm = lookup(['returnOnAssetsPercentLtm', 'returnonassetspercentltm']);
            break;
          case 'returnOnEquityPercentLtm':
            mapped.returnOnEquityPercentLtm = lookup(['returnOnEquityPercentLtm', 'returnonequitypercentltm']);
            break;
          case 'totalDebtEquityPercentLtm':
            mapped.totalDebtEquityPercentLtm = lookup(['totalDebtEquityPercentLtm', 'totaldebtequitypercentltm']);
            break;
          case 'longTermDebtEquityPercentLtm':
            mapped.longTermDebtEquityPercentLtm = lookup(['longTermDebtEquityPercentLtm', 'longtermdebtequitypercentltm']);
            break;
          case 'returnOnTotalCapitalLtm':
            mapped.returnOnTotalCapitalLtm = lookup(['returnOnTotalCapitalLtm', 'returnontotalcapitalltm']);
            break;
          case 'netIncomeMarginPercentLtm':
            mapped.netIncomeMarginPercentLtm = lookup(['netIncomeMarginPercentLtm', 'netincomemarginpercentltm']);
            break;
          case 'altmanZScoreLtm':
            mapped.altmanZScoreLtm = lookup(['altmanZScoreLtm', 'altmanzscoreltm']);
            break;
          case 'quickRatioLtm':
            mapped.quickRatioLtm = lookup(['quickRatioLtm', 'quickratioltm']);
            break;
          case 'totalDebtEbitdaLtm':
            mapped.totalDebtEbitdaLtm = lookup(['totalDebtEbitdaLtm', 'totaldebtebitdaltm']);
            break;
          case 'ebitdaMarginPercentLtm':
            mapped.ebitdaMarginPercentLtm = lookup(['ebitdaMarginPercentLtm', 'ebitdamarginpercentltm']);
            break;
          case 'netDebtEbitdaLtm':
            mapped.netDebtEbitdaLtm = lookup(['netDebtEbitdaLtm', 'netdebtebitdaltm']);
            break;
          case 'epsGrowthPercentLtm':
            mapped.epsGrowthPercentLtm = lookup(['epsGrowthPercentLtm', 'epsgrowthpercentltm']);
            break;
          case 'forwardDividendYieldPercent':
            mapped.forwardDividendYieldPercent = lookup(['forwardDividendYieldPercent', 'forwarddividendyieldpercent']);
            break;
          case 'operatingCashFlowToCurrentLiabilitiesLtm':
            mapped.operatingCashFlowToCurrentLiabilitiesLtm = lookup(['operatingCashFlowToCurrentLiabilitiesLtm', 'operatingcashflowtocurrentliabilitiesltm']);
            break;
          case 'ebitdaInterestExpenseLtm':
            mapped.ebitdaInterestExpenseLtm = lookup(['ebitdaInterestExpenseLtm', 'ebitdainterestexpenseltm']);
            break;
          case 'ebitInterestExpenseLtm':
            mapped.ebitInterestExpenseLtm = lookup(['ebitInterestExpenseLtm', 'ebitinterestexpenseltm']);
            break;
          case 'totalRevenue1YrGrowthPercentLtm':
            mapped.totalRevenue1YrGrowthPercentLtm = lookup(['totalRevenue1YrGrowthPercentLtm', 'totalrevenue1yrgrowthpercentltm']);
            break;
          case 'netIncome1YrGrowthPercentLtm':
            mapped.netIncome1YrGrowthPercentLtm = lookup(['netIncome1YrGrowthPercentLtm', 'netincome1yrgrowthpercentltm']);
            break;
          case 'basicEpsContinuingOperationsLtm':
            mapped.basicEpsContinuingOperationsLtm = lookup(['basicEpsContinuingOperationsLtm', 'basicepscontinuingoperationsltm']);
            break;
          case 'revenueGrowthPercentYoYQuarterly':
            mapped.revenueGrowthPercentYoYQuarterly = lookup(['revenueGrowthPercentYoYQuarterly', 'revenuegrowthpercentyoyquarterly']);
            break;
          case 'totalRevenueLtm':
            mapped.totalRevenueLtm = lookup(['totalRevenueLtm', 'totalrevenueltm']);
            break;
          case 'totalRevenueAnnualMarketCurrency':
            mapped.totalRevenueAnnualMarketCurrency = lookup(['totalRevenueAnnualMarketCurrency', 'totalrevenueannualmarketcurrency']);
            break;
          case 'totalRevenuePerEmployeeAnnualMarketCurrency':
            mapped.totalRevenuePerEmployeeAnnualMarketCurrency = lookup(['totalRevenuePerEmployeeAnnualMarketCurrency', 'totalrevenueperemployeeannualmarketcurrency']);
            break;
          case 'netEpsBasicLtm':
            mapped.netEpsBasicLtm = lookup(['netEpsBasicLtm', 'netepsbasicltm']);
            break;
          case 'ebitda1YrGrowthPercentLtm':
            mapped.ebitda1YrGrowthPercentLtm = lookup(['ebitda1YrGrowthPercentLtm', 'ebitda1yrgrowthpercentltm']);
            break;
          case 'dilutedEps1YrGrowthPercentLtm':
            mapped.dilutedEps1YrGrowthPercentLtm = lookup(['dilutedEps1YrGrowthPercentLtm', 'dilutedeps1yrgrowthpercentltm']);
            break;
          case 'netEpsDilutedLtm':
            mapped.netEpsDilutedLtm = lookup(['netEpsDilutedLtm', 'netepsdilutedltm']);
            break;
          case 'netIncomeIsLtm':
            mapped.netIncomeIsLtm = lookup(['netIncomeIsLtm', 'netincomeisltm']);
            break;
          case 'netIncomeIsAnnualMarketCurrency':
            mapped.netIncomeIsAnnualMarketCurrency = lookup(['netIncomeIsAnnualMarketCurrency', 'netincomeisannualmarketcurrency']);
            break;
          case 'netIncomePerEmployeeAnnualMarketCurrency':
            mapped.netIncomePerEmployeeAnnualMarketCurrency = lookup(['netIncomePerEmployeeAnnualMarketCurrency', 'netincomeperemployeeannualmarketcurrency']);
            break;
          case 'operatingIncomeLtm':
            mapped.operatingIncomeLtm = lookup(['operatingIncomeLtm', 'operatingincomeltm']);
            break;
          case 'grossProfitLtm':
            mapped.grossProfitLtm = lookup(['grossProfitLtm', 'grossprofitltm']);
            break;
          case 'ebitdaLtm':
            mapped.ebitdaLtm = lookup(['ebitdaLtm', 'ebitdaltm']);
            break;
          case 'dilutedEpsContinuingOperationsLtm':
            mapped.dilutedEpsContinuingOperationsLtm = lookup(['dilutedEpsContinuingOperationsLtm', 'dilutedepscontinuingoperationsltm']);
            break;
          case 'ebitLtm':
            mapped.ebitLtm = lookup(['ebitLtm', 'ebitltm']);
            break;
          case 'sector':
            mapped.sector = lookup(['sector']);
            break;
          case 'industry':
            mapped.industry = lookup(['industry']);
            break;
          case 'exchange':
            mapped.exchange = lookup(['exchange']);
            break;
          case 'region':
            mapped.region = lookup(['region']);
            break;
          case 'currency':
            mapped.currency = lookup(['currency']);
            break;
          default:
            mapped[field] = lookup([field]);
        }
      }
      return mapped;
    });

    const nextOffset = offset + records.length < totalCount ? offset + records.length : null;

    return {
      records,
      totalCount,
      nextOffset,
    };
  }

}