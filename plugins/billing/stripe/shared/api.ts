/**
 * Calling Stripe: its REST API over `fetch`, with no package to carry, on one
 * API version. Parameters go form-encoded, nested as `a[b][0]=c`.
 */
export const API_VERSION = "2026-10-28.endive";
const BASE = "https://api.stripe.com";

type Params = Record<string, unknown>;

/** `{ a: { b: [1] } }` as `a[b][0]=1`; what's undefined is left out. */
export function encode(params: Params, prefix = ""): [string, string][] {
  return Object.entries(params).flatMap(([key, value]): [string, string][] => {
    if (value === undefined || value === null) return [];
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      return value.flatMap((item, i) =>
        typeof item === "object"
          ? encode(item as Params, `${name}[${i}]`)
          : [[`${name}[${i}]`, String(item)] as [string, string]]
      );
    }
    return typeof value === "object"
      ? encode(value as Params, name)
      : [[name, String(value)] as [string, string]];
  });
}

export async function stripeCall<R = Record<string, unknown>>(
  options: { key: string; fetch?: typeof fetch; idempotency?: string },
  method: "GET" | "POST",
  path: string,
  params: Params = {},
): Promise<R> {
  const pairs = encode(params);
  const body = new URLSearchParams(pairs).toString();
  const url = method === "GET" && body ? `${BASE}${path}?${body}` : `${BASE}${path}`;
  const response = await (options.fetch ?? fetch)(url, {
    method,
    headers: {
      authorization: `Bearer ${options.key}`,
      "stripe-version": API_VERSION,
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotency ? { "idempotency-key": options.idempotency } : {}),
    },
    ...(method === "POST" ? { body } : {}),
  });
  const answer = await response.json().catch(() => ({})) as {
    error?: { message?: string; code?: string; type?: string };
  };
  if (!response.ok) {
    throw Object.assign(
      new Error(answer.error?.message ?? `Stripe answered ${response.status}.`),
      { code: answer.error?.code ?? "stripe", status: response.status },
    );
  }
  return answer as R;
}
