/**
 * Why an account can't be used, by code, in words that never hold a token:
 * what a model provider's fallbacks move on from, and what the page says.
 *
 * - `account_missing`: nothing connected for whom the call is for (or it's
 *   for nobody);
 * - `account_needs_reconnect`: connected once, but it must be signed in again;
 * - `account_unavailable`: the provider can't be reached now, or its tokens
 *   can't be opened here: nothing is lost, and it's tried again;
 * - `account_refused`: the provider said no (a code it wouldn't take).
 */
const coded = (code: string) => (message: string) => Object.assign(new Error(message), { code });

export const missing = coded("account_missing");
export const lapsed = coded("account_needs_reconnect");
export const unavailable = coded("account_unavailable");
export const refused = coded("account_refused");
export const invalid = coded("invalid");
export const forbidden = coded("forbidden");

export const codeOf = (error: unknown) => (error as { code?: string })?.code;
