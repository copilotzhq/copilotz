/**
 * A person's plans in the command palette (kind `computer.plans.palette`,
 * the web shell's `palette` resource), under General: going to them on
 * Connected accounts, and for each plan, signing it in (its dialog, on that
 * page: `?signin=claude`), or, signed in, where. What each computer last
 * said of its CLIs is on it (`computer.mine`): the palette asks none.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup, PaletteItem } from "../../../../../hosts/web/mod.ts";
import type { Computer } from "../../collections/computer.ts";
import type { EngineName, EngineSeen } from "../../shared/engines.ts";
import { nameOf } from "./names.ts";
import { plans } from "./plans.ts";
import { say } from "./words.ts";

export const plansPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const mine = ctx.db.collection("computer").query<Computer[]>("mine", {}).value;
  if (!mine) return null;
  const words = say("paletteKeywords").split(",").map((w) => w.trim()).filter(Boolean);
  const items: PaletteItem[] = [{
    key: "plans:open",
    label: say("palettePlans"),
    icon: "sparkles",
    keywords: [...words, ...plans().map((p) => p.title)],
    href: "/accounts",
  }];
  for (const plan of plans()) {
    const on = mine.filter((c) =>
      (c.engines as Partial<Record<EngineName, EngineSeen>> | undefined)?.[plan.engine]?.signedIn
    );
    const keywords = [plan.title, plan.cli, ...words];
    items.push(
      on.length
        ? {
          key: `plans:signed:${plan.engine}`,
          label: plan.title,
          icon: "sparkles",
          description: on.length === 1
            ? say("paletteSignedIn", { computer: nameOf(on[0]) })
            : say("paletteSignedInMany", { count: on.length }),
          keywords,
          href: "/accounts",
        }
        : {
          key: `plans:signin:${plan.engine}`,
          label: say("paletteSignIn", { plan: plan.plan }),
          icon: "sparkles",
          description: plan.cli,
          keywords,
          href: `/accounts?signin=${plan.engine}`,
        },
    );
  }
  return [{ title: say("paletteGroup"), order: 90, items }];
};
