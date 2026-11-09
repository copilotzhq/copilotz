/**
 * Tiers as the web says them: what a typical reply comes to, in cents people
 * can compare ("about 4¢ a reply"); how hard a model is asked to think; and
 * where an agent's model comes from, as the org's page says it ("Expert,
 * chosen by your org") and as a space's says it ("the org's Everyday").
 */
import type { From } from "../../contract.ts";

/** A typical reply's price: "0.3¢", "4¢", "$1.20"; none when nothing prices it. */
export function perReply(usd: number | null | undefined): string | undefined {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return undefined;
  const cents = usd * 100;
  if (cents < 0.05) return "under 0.1¢";
  if (cents < 10) return `${+cents.toFixed(1)}¢`;
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${usd.toFixed(2)}`;
}

const EFFORTS: Record<string, string> = {
  none: "no reasoning",
  minimal: "minimal effort",
  low: "low effort",
  medium: "medium effort",
  high: "high effort",
  xhigh: "extra-high effort",
  max: "max effort",
};

/** How hard it's asked to think, in words: "high effort". */
export const effortSaid = (effort?: string): string | undefined =>
  effort ? EFFORTS[effort] ?? `${effort} effort` : undefined;

type Titled = From & { title?: string };

const titleOf = (from: Titled) => from.title ?? ("tier" in from ? from.tier : undefined) ?? "";

/** Where an agent's model comes from, on the org's page: "Expert, chosen by your org". */
export function orgFromSaid(from: Titled): string {
  if (from.by === "app") return "its own model";
  if ("custom" in from) return "picked by your org";
  if (from.by === "plan") return `${titleOf(from)}, your plan's default`;
  return `${titleOf(from)}, chosen by your org`;
}

/** Where an agent's model comes from, in a space: "the org's Everyday", "picked for this space". */
export function spaceFromSaid(from: Titled): string {
  if (from.by === "app") return "its own model";
  if ("custom" in from) return from.by === "space" ? "picked for this space" : "the org's pick";
  if (from.by === "space") return `this space's ${titleOf(from)}`;
  if (from.by === "org") return `the org's ${titleOf(from)}`;
  return `the plan's ${titleOf(from)}`;
}

/** Who chose the tier in force, as its badge says: "Chosen by your org", "Your plan's default". */
export const chosenSaid = (by: "space" | "org" | "plan"): string =>
  by === "plan" ? "Your plan's default" : by === "org" ? "Chosen by your org" : "Chosen here";
