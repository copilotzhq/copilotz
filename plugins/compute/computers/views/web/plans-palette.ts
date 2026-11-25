/**
 * A person's plans in the command palette (kind `computer.plans.palette`,
 * the web shell's `palette` resource), under General: for each plan the
 * app uses, connecting it (the connect flow, on that
 * page: `?connect=<plan>`), or, connected, where it stands.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup, PaletteItem } from "../../../../../hosts/web/mod.ts";
import { sayText } from "../../../../../hosts/web/mod.ts";
import { plansData } from "./plans-data.ts";
import { cardOf } from "./plan-states.ts";
import { sentence } from "./plan-card.tsx";
import { say } from "./words.ts";

export const plansPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const data = plansData(ctx);
  if (!data) return null;
  const words = say("paletteKeywords").split(",").map((w) => w.trim()).filter(Boolean);
  // Going to Your AI is the accounts' own command: these are each plan's.
  const items: PaletteItem[] = [];
  for (const plan of data.plans) {
    const card = cardOf(plan, data.machines, data.accounts);
    const name = sayText(plan.plan);
    const keywords = [name, ...plan.ways.map((w) => sayText(w.title)), ...words];
    items.push(
      card.state === "ready"
        ? {
          key: `plans:connected:${plan.plan}`,
          label: name,
          icon: "sparkles",
          description: sentence(card),
          keywords,
          href: "/accounts",
        }
        : {
          key: `plans:connect:${plan.plan}`,
          label: say("paletteConnect", { plan: name }),
          icon: "sparkles",
          description: sentence(card),
          keywords,
          href: `/accounts?connect=${encodeURIComponent(plan.plan)}`,
        },
    );
  }
  return [{ title: say("paletteGroup"), order: 90, items }];
};
