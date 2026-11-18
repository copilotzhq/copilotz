/**
 * Tiers as the web says them: what a typical message (or reply) comes to, in
 * cents people can compare ("2¢ a message"), and how far the plan's credits
 * go at that ("about 220 messages with Free's $5"); how hard a model is asked
 * to think; who chose the tier in force ("the org's default"); and who runs
 * a model ("OpenAI").
 */
import type { By, CreditsShown, KindShown, Shown, TierShown } from "../../contract.ts";
import { formatNumber, sayText } from "copilotz/web/words";
import { say } from "./say.ts";

/** What prices are for: "a message", or "a reply" where the app measured no message. */
export const unitSaid = (per: Shown["per"]): string =>
  per === "message" ? say("perMessage") : say("perReply");

/** About how many: exact under 20, then to the nearest 5, and the nearest 10 from 100. */
export function about(count: number): number {
  if (count < 20) return Math.floor(count);
  if (count < 100) return Math.round(count / 5) * 5;
  return Math.round(count / 10) * 10;
}

/** Dollars as people write them: "$5", "$12.50". */
const dollars = (usd: number) => `$${formatNumber(usd, Number.isInteger(usd) ? {} : CENTS)}`;

/** Two decimals, always: "$1.20". */
const CENTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/**
 * How far the plan's credits go at a price: "about 220 messages with Free's
 * $5", "about 490 messages a month with Personal's $10", "about 980 messages
 * a month for each seat on Team"; none when nothing's priced or given.
 */
export function creditsGo(
  credits: CreditsShown | null,
  price: number | null,
  per: Shown["per"],
): string | undefined {
  if (!credits?.amount || !price) return undefined;
  const count = about(credits.amount / price);
  const things = say(per === "message" ? "messages" : "replies", { count });
  const amount = dollars(credits.amount);
  if (credits.every === "once") return say("creditsOnce", { things, plan: credits.title, amount });
  if (credits.perSeat) return say("creditsSeat", { things, plan: credits.title });
  return say("creditsMonth", { things, plan: credits.title, amount });
}

/** How many times faster one price spends than another: "13×"; none when it's no faster. */
export function faster(price: number | null, than: number | null): string | undefined {
  if (!price || !than || price <= than * 1.05) return undefined;
  const times = price / than;
  return `${formatNumber(times < 10 ? +times.toFixed(1) : Math.round(times))}×`;
}

/** A typical message's price: "0.3¢", "4¢", "$1.20"; none when nothing prices it. */
export function perReply(usd: number | null | undefined): string | undefined {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return undefined;
  const cents = usd * 100;
  if (cents < 0.05) return say("underTenth");
  if (cents < 10) return `${formatNumber(+cents.toFixed(1))}¢`;
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${formatNumber(usd, CENTS)}`;
}

const EFFORTS = {
  none: "effortNone",
  minimal: "effortMinimal",
  low: "effortLow",
  medium: "effortMedium",
  high: "effortHigh",
  xhigh: "effortXhigh",
  max: "effortMax",
} as const;

/** How hard it's asked to think, in words: "high effort". */
export const effortSaid = (effort?: string): string | undefined =>
  effort
    ? Object.hasOwn(EFFORTS, effort)
      ? say(EFFORTS[effort as keyof typeof EFFORTS])
      : say("effortOther", { effort })
    : undefined;

/** Who chose the tier in force, as a line says it: "chosen for this chat", "the org's default". */
export function bySaid(by: By): string {
  switch (by) {
    case "thread":
      return say("byThread");
    case "person":
      return say("byPerson");
    case "space":
      return say("bySpace");
    case "org":
      return say("byOrg");
    default:
      return say("byPlan");
  }
}

/** Who runs a model, from its id: "OpenAI", "your ChatGPT plan". */
export function providerSaid(id: string): string {
  const provider = id.slice(0, id.indexOf("/"));
  const known: Record<string, string> = {
    chatgpt: say("providerChatgpt"),
    openai: "OpenAI",
    anthropic: "Anthropic",
    google: "Google",
    deepseek: "DeepSeek",
    minimax: "MiniMax",
  };
  return known[provider] ?? provider;
}

/** A model, with its effort: "Claude Haiku 5.5, low effort". */
export const modelSaid = (model: { name: string; effort?: string }): string =>
  effortSaid(model.effort) ? `${model.name}, ${effortSaid(model.effort)}` : model.name;

/**
 * What the tiers show, in the app's words (`sayText`): each tier's name and description, each
 * kind of work's title and description, as the app declared them; what an org wrote shows as is.
 */
export function shownSaid<T extends { tiers?: TierShown[]; kinds?: KindShown[] }>(
  shown: T | undefined,
): T | undefined {
  if (!shown) return shown;
  const said = <X extends { title: string; description?: string }>(x: X): X => ({
    ...x,
    title: sayText(x.title),
    ...(x.description ? { description: sayText(x.description) } : {}),
  });
  return {
    ...shown,
    ...(shown.tiers ? { tiers: shown.tiers.map(said) } : {}),
    ...(shown.kinds ? { kinds: shown.kinds.map(said) } : {}),
  };
}
