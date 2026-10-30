/**
 * What connected accounts offer in the command palette (kind
 * `accounts.palette`, the web shell's `palette` resource), under General:
 * going to Connected accounts, and for each provider, connecting it (its
 * dialog, on the page), reconnecting it when it needs it, or disconnecting
 * it, once the person has read what that means.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup, PaletteItem } from "../../../../../hosts/web/mod.ts";
import type { Account, ProviderShown } from "../../contract.ts";
import { whoOf } from "./words.ts";

const WORDS = ["account", "connect", "sign in", "plan", "subscription"];

export const accountsPaletteView = (
  _: unknown,
  ctx: ViewContext<ReactNode>,
): PaletteGroup[] | null => {
  const providers = ctx.db.collection("account").query<ProviderShown[]>("providers", {}).value;
  const accounts = ctx.db.collection<Account>("account").find({}).value;
  if (!providers || !accounts) return null;
  const items: PaletteItem[] = [{
    key: "accounts:open",
    label: "Connected accounts",
    icon: "lock",
    keywords: [...WORDS, ...providers.map((p) => p.title)],
    href: "/accounts",
  }];
  for (const provider of providers) {
    const account = accounts.find((a) => a.provider === provider.name);
    const words = [provider.title, ...WORDS];
    if (!account || account.status !== "connected") {
      items.push({
        key: `accounts:connect:${provider.name}`,
        label: `${account ? "Reconnect" : "Connect"} ${provider.title}`,
        icon: provider.icon ?? "lock",
        description: account ? "It needs signing in again" : undefined,
        keywords: words,
        href: `/accounts?connect=${encodeURIComponent(provider.name)}`,
      });
    } else {
      items.push({
        key: `accounts:account:${provider.name}`,
        label: `${provider.title} account`,
        icon: provider.icon ?? "lock",
        description: whoOf(account),
        keywords: words,
        href: "/accounts",
      }, {
        key: `accounts:disconnect:${provider.name}`,
        label: `Disconnect ${provider.title}…`,
        icon: "signout",
        description: whoOf(account),
        keywords: [...words, "disconnect", "remove"],
        step: {
          title: `Disconnect ${provider.title}?`,
          confirm: true,
          note: provider.models?.length
            ? "Agents working for you stop running on it, and use the app's own models instead."
            : "Agents working for you stop using it.",
          items: () => [{
            title: "",
            items: [
              {
                key: `accounts:disconnect:${provider.name}:yes`,
                label: `Disconnect ${provider.title}`,
                icon: "signout",
                tone: "destructive",
                run: () => ctx.call("account.disconnect", { provider: provider.name }),
              },
              {
                key: `accounts:disconnect:${provider.name}:no`,
                label: "Keep it",
                icon: "close",
                run: (p) => p.back(),
              },
            ],
          }],
        },
      });
    }
  }
  return [{ title: "General", order: 90, items }];
};
