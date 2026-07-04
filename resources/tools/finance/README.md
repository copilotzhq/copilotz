# Finance Data Tool

A native Copilotz tool for retrieving market, company, and financial data from Yahoo Finance, behind a swappable `FinanceDataProvider` interface.

## Features

- **Stateless per-call cookie/crumb acquisition**: Avoids global mutable state and import-time side effects.
- **8 discrete actions**: `search_assets`, `get_market_snapshot`, `get_company_profile`, `get_historical_prices`, `get_analyst_ratings`, `get_calendar_events`, `get_ownership`, and `get_financial_statements`.
- **Output bounding**: All actions support truncation limits (`max_rows`, `max_periods`, `max_officers`, `max_events`) and return `truncated: boolean`.
- **Cooperative cancellation**: Supports `AbortSignal` via `context.onCancel`.
- **Robust error handling**: Translates upstream errors into clean `FinanceError` codes.

## Usage Examples

### 1. Search Assets
```json
{
  "action": "search_assets",
  "query": "Apple"
}
```

### 2. Get Market Snapshot
```json
{
  "action": "get_market_snapshot",
  "symbol": "AAPL"
}
```

### 3. Get Financial Statements
```json
{
  "action": "get_financial_statements",
  "symbol": "AAPL",
  "statement_type": "income_statement",
  "period_type": "annual",
  "max_periods": 3
}
```
