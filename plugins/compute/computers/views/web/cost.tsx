/**
 * What a computer the app keeps costs the person looking (kind
 * `computer.cost`; item `{ computer? }`, none: a new one), in a line, by
 * `hints.mode`:
 *
 * - `price` (a new one, the default without `computer`): "About 16¢ per
 *   hour of work, and it sleeps 10 minutes after." and how far the org
 *   plan's credits go: "Your $5 covers about 18 hours of work, after this
 *   month's disk."
 * - `cost` (one of theirs, the default with `computer`): its hour line.
 * - `month` (one of theirs): "This month: 2h 40m awake · $0.43 · disk $2.00".
 *
 * Nothing when it isn't priced (`computer.cost` answers null): a person's
 * own machine, an app that prices none. Other front ends place it (Your AI,
 * the choice of where plans run); every number is the app's.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { formatNumber } from "../../../../../hosts/web/words.ts";
import type { ComputerCost } from "../../shared/cost.ts";
import { say } from "./words.ts";

export type CostMode = "price" | "cost" | "month";

const CENTS = { minimumFractionDigits: 2, maximumFractionDigits: 2 };

/** Dollars as people write them: "$5", "$12.50", "$0.43". */
const dollars = (usd: number, cents = !Number.isInteger(usd)) =>
  `$${formatNumber(usd, cents ? CENTS : {})}`;

/** An hour's price: "16¢", "4.5¢", "$1.20". */
const hourly = (usd: number) => {
  const cents = usd * 100;
  if (cents >= 100) return dollars(usd, true);
  return `${formatNumber(cents < 10 ? +cents.toFixed(1) : Math.round(cents))}¢`;
};

/** Time awake: "2h 40m", "12m". */
const awake = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours
    ? say("awakeHours", { hours, minutes: minutes % 60 })
    : say("awakeMinutes", { minutes });
};

/** The lines a mode says of a cost, in order. */
export function costSaid(cost: ComputerCost, mode: CostMode): string[] {
  if (mode === "month") {
    if (!cost.month) return [];
    const said = { awake: awake(cost.month.seconds), price: dollars(cost.month.price, true) };
    return [
      cost.diskMonth === null
        ? say("costMonthNoDisk", said)
        : say("costMonth", { ...said, disk: dollars(cost.diskMonth, true) }),
    ];
  }
  const hour = say("costHour", { price: hourly(cost.hour), count: cost.warmMinutes });
  if (mode === "cost" || !cost.covers) return [hour];
  const { hours, amount, every } = cost.covers;
  const covers = say(every === "once" ? "costCoversOnce" : "costCoversMonth", {
    amount: dollars(amount),
    count: hours,
  });
  return [hour, covers];
}

export const computerCostView = (
  item: { computer?: string },
  ctx: ViewContext<ReactNode>,
): ReactNode => {
  const cost = ctx.db.collection("computer").query<ComputerCost | null>(
    "cost",
    item.computer ? { computer: item.computer } : {},
  ).value;
  if (!cost) return null;
  const asked = ctx.hints.mode;
  const mode: CostMode = asked === "price" || asked === "cost" || asked === "month"
    ? asked
    : item.computer
    ? "cost"
    : "price";
  const lines = costSaid(cost, mode);
  return lines.length ? <span className="computer-cost">{lines.join(" ")}</span> : null;
};
