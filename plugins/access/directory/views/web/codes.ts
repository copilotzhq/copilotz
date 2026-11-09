/**
 * Gift codes in staff's console, as words: where each stands, and what a person
 * types turned into what's asked for. Pure.
 */
import { formatDate, formatNumber } from "../../../../../hosts/web/words.ts";
import type { GiftCode } from "./orgs.ts";
import { say } from "./words.ts";

export type CodeStatus = "waiting" | "claimed" | "revoked" | "expired";

/** Where a code stands: claimed, taken back, past its last moment, or still waiting. */
export function codeStatus(code: GiftCode, now = new Date().toISOString()): CodeStatus {
  if (code.org) return "claimed";
  if (code.revoked) return "revoked";
  if (code.until && code.until <= now) return "expired";
  return "waiting";
}

/** The status as a label (said now, in the app's words), with the toolkit's tone for it. */
export const statusOf = (
  status: CodeStatus,
): { label: string; tone: "success" | "neutral" | "primary" | "warning" } =>
  ({
    waiting: { label: say("codeWaiting"), tone: "primary" as const },
    claimed: { label: say("codeClaimed"), tone: "success" as const },
    revoked: { label: say("codeRevoked"), tone: "neutral" as const },
    expired: { label: say("codeExpired"), tone: "neutral" as const },
  })[status];

/** What the form asks for, as `POST /console/codes` takes it; or why it can't be. */
export function newCodeOf(
  form: { amount: string; expires: string; until: string; note: string },
): { amount: number; expires?: string; until?: string; note?: string } | { error: string } {
  const amount = Number(form.amount.trim().replace(/^\$\s*/, "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return { error: say("sayDollars") };
  return {
    amount: Math.round(amount * 100) / 100,
    ...(form.expires ? { expires: form.expires } : {}),
    // A code can be claimed through the whole of its last day.
    ...(form.until ? { until: `${form.until}T23:59:59.999Z` } : {}),
    ...(form.note.trim() ? { note: form.note.trim() } : {}),
  };
}

/** A day (`YYYY-MM-DD`, or a moment's), as the calendar has it, wherever you are. */
export const dayOf = (at: string): string =>
  formatDate(new Date(`${at.slice(0, 10)}T00:00:00Z`), {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** US dollars, cents only when there are some. */
export const dollarsOf = (n: number): string =>
  formatNumber(n, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
