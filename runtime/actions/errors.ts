/** The one approved safe service-unavailable result has fixed public semantics. */
export function isCallerSafeActionStatus(
  status: unknown,
  code: unknown,
  message: unknown,
): boolean {
  return Number.isInteger(status) &&
    ((Number(status) >= 400 && Number(status) <= 499) ||
      (status === 503 && code === "auth_unavailable" &&
        message === "Authentication is unavailable"));
}
const standardErrors = Object.freeze({
  forbidden: { status: 403, message: "Forbidden" },
  unauthorized: { status: 401, message: "Unauthorized" },
  credential_unavailable: { status: 401, message: "Credential unavailable" },
  invalid_input: { status: 400, message: "Invalid input" },
  auth_unavailable: { status: 503, message: "Authentication is unavailable" },
});
/** Reconstruct only approved standard failures; never retain caller text/cause/data. */
export function standardActionError(value: unknown): ActionError | undefined {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return;
  }
  const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
  const status = Object.getOwnPropertyDescriptor(value, "status")?.value;
  if (typeof code !== "string" || !Object.hasOwn(standardErrors, code)) return;
  const standard = standardErrors[code as keyof typeof standardErrors];
  if (status !== standard.status) return;
  return new ActionError(standard.message, { code, status: standard.status });
}

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
    if (!isCallerSafeActionStatus(status, options.code, message)) {
      throw new RangeError(
        "ActionError requires a 4xx status or the fixed authentication-unavailable result.",
      );
    }
    this.name = "ActionError";
    this.code = options.code;
    this.status = status;
  }
}
