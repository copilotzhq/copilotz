/**
 * Which account a model would run on, for the person asking: the first of
 * a model choice's models (aliases and lists followed, as the models plugin
 * tries them) whose provider an account pays for and whose account they've
 * connected. A model of the app's own (one no account pays for) stops the
 * search: from there, it's the app's. An account that needs reconnecting
 * is passed over, as the call would be, and said so.
 */
import type { Resources } from "../../../../runtime/mod.ts";
import type { ModelRef } from "../../../models/contract.ts";
import type { Account, Uses, UsesParams } from "../contract.ts";
import { providersOf } from "./settings.ts";

/** The `"provider/model"`s a model choice names, in the order they're tried. */
export function idsOf(
  ref: unknown,
  aliases: Record<string, unknown> = {},
  seen: string[] = [],
): string[] {
  if (Array.isArray(ref)) return ref.flatMap((r) => idsOf(r, aliases, seen));
  if (typeof ref === "string") {
    if (ref.includes("/")) return [ref];
    return seen.includes(ref) ? [] : idsOf(aliases[ref], aliases, [...seen, ref]);
  }
  return ref && typeof ref === "object"
    ? idsOf((ref as { model?: unknown }).model, aliases, seen)
    : [];
}

export function usesOf(
  ctx: { resources: Resources },
  accounts: Pick<Account, "provider" | "status" | "label" | "plan">[],
  params: UsesParams,
): Uses {
  const providers = providersOf(ctx);
  // Which account provider pays for each model provider.
  const payer = new Map<string, string>();
  for (const [name, p] of Object.entries(providers)) {
    for (const model of p.models ?? []) payer.set(model, name);
  }
  const uses: Uses = {};
  for (const [agent, ref] of Object.entries(params.models ?? {})) {
    let lapsed: string | undefined;
    for (const id of idsOf(ref as ModelRef, ctx.resources.model)) {
      const name = payer.get(id.slice(0, id.indexOf("/")));
      if (!name) break;
      const found = accounts.find((a) => a.provider === name);
      if (found?.status === "connected") {
        uses[agent] = {
          provider: name,
          title: providers[name].title,
          label: found.label,
          ...(found.plan ? { plan: found.plan } : {}),
        };
        break;
      }
      if (found) lapsed ??= name;
    }
    if (!uses[agent] && lapsed) {
      uses[agent] = { provider: lapsed, title: providers[lapsed].title, reconnect: true };
    }
  }
  return uses;
}
