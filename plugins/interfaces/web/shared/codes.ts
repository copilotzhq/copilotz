/**
 * Gift codes in staff's console, as words: where each stands, and what a person
 * types turned into what's asked for. Pure.
 */
import type { GiftCode } from "../../../../hosts/web/mod.ts";

export type CodeStatus = "waiting" | "claimed" | "revoked" | "expired";

/** Where a code stands: claimed, taken back, past its last moment, or still waiting. */
export function codeStatus(code: GiftCode, now = new Date().toISOString()): CodeStatus {
  if (code.org) return "claimed";
  if (code.revoked) return "revoked";
  if (code.until && code.until <= now) return "expired";
  return "waiting";
}

/** The status as a label, with the toolkit's tone for it. */
export const STATUS: Record<
  CodeStatus,
  { label: string; tone: "success" | "neutral" | "primary" | "warning" }
> = {
  waiting: { label: "Waiting", tone: "primary" },
  claimed: { label: "Claimed", tone: "success" },
  revoked: { label: "Taken back", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
};

/** What the form asks for, as `POST /console/codes` takes it; or why it can't be. */
export function newCodeOf(
  form: { amount: string; expires: string; until: string; note: string },
): { amount: number; expires?: string; until?: string; note?: string } | { error: string } {
  const amount = Number(form.amount.trim().replace(/^\$\s*/, "").replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Say how many dollars of credits." };
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
  new Date(`${at.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

/** US dollars, cents only when there are some. */
export const dollarsOf = (n: number): string =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  });
