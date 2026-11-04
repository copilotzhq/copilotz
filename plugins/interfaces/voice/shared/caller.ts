/**
 * Who's calling, as far as a number can say: the caller's number when
 * Twilio gives a real one, and nobody's (hidden) when it doesn't. Twilio
 * puts placeholders in `From` for a withheld caller ID (they look like
 * numbers, and aren't anyone's): those, and anything that isn't a plausible
 * E.164 number, are hidden. Each hidden call is a caller of its own.
 *
 * A number isn't proof of who's calling either (caller ID can be faked):
 * only Twilio's verification says it is (STIR/SHAKEN's full attestation,
 * `StirVerstat: TN-Validation-Passed-A`), unless the line trusts numbers.
 */

/**
 * Twilio's placeholders for a caller ID it doesn't give: anonymous, unavailable, unknown,
 * blocked, restricted.
 */
const PLACEHOLDERS = new Set(["266696687", "86282452253", "8656696", "2562533", "7378742833"]);

/** What Twilio says when it verified the number calls from whom it says (STIR/SHAKEN "A"). */
export const VERIFIED = "TN-Validation-Passed-A";

/** The caller's number (`+5511…`), or undefined when it's hidden. */
export function numberOf(from: string | undefined): string | undefined {
  const digits = /^\+?([1-9]\d{7,14})$/.exec((from ?? "").trim())?.[1];
  return digits && !PLACEHOLDERS.has(digits) ? `+${digits}` : undefined;
}

/**
 * The key a line's limits and blocks know a caller by: their number, or
 * `hidden` for every call whose number is (they can't be told apart, so
 * they share an allowance of their own: the line's `hidden…` limits).
 */
export const callerKey = (from: string | undefined) => numberOf(from) ?? "hidden";

/**
 * A blocked caller's key: the line, and a hash of the caller's key (an
 * unkeyed hash: someone holding the database could find a number by trying
 * them all, but nothing outside reads it).
 */
export async function blockedKey(line: string, from: string | undefined): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(callerKey(from)));
  return `${line}:${
    [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("")
  }`;
}
