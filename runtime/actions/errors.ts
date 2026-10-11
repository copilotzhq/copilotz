/** An Action refusal whose message and code may be shown to HTTP callers. */
export class ActionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, options: { code: string; status?: number }) {
    super(message);
    const status = options.status ?? 422;
    if (!message.trim() || !options.code.trim()) {
      throw new TypeError("ActionError message and code must be non-empty.");
    }
    if (!Number.isInteger(status) || status < 400 || status > 499) {
      throw new RangeError("ActionError status must be a 4xx HTTP status.");
    }
    this.name = "ActionError";
    this.code = options.code;
    this.status = status;
  }
}
