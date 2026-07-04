export type FinanceErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'rate_limited'
  | 'crumb_expired'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'parse_error'
  | 'unsupported';

export interface FinanceErrorOptions {
  code: FinanceErrorCode;
  message: string;
  symbol?: string;
  cause?: unknown;
}

export class FinanceError extends Error {
  public readonly code: FinanceErrorCode;
  public readonly symbol?: string;

  constructor(options: FinanceErrorOptions) {
    super(options.message);
    this.name = 'FinanceError';
    this.code = options.code;
    this.symbol = options.symbol;
    if (options.cause) {
      this.cause = options.cause;
    }
    Object.setPrototypeOf(this, FinanceError.prototype);
  }

  public toJSON() {
    return {
      error: {
        name: this.name,
        code: this.code,
        message: this.message,
        symbol: this.symbol,
      },
    };
  }
}
