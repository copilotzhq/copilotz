/** The web tools' settings, with their defaults. */
import type { Context } from "../../../../runtime/mod.ts";
import type { WebToolsSettings } from "../contract.ts";

export const USER_AGENT =
  "Mozilla/5.0 (compatible; CopilotzBot/1.0; +https://github.com/copilotzhq/copilotz)";

export function settingsOf(ctx: Pick<Context, "resources">) {
  const s = (ctx.resources.webTools ?? {}) as WebToolsSettings;
  return {
    search: {
      adapter: s.search?.adapter ?? "serper",
      apiKey: s.search?.apiKey,
      endpoint: s.search?.endpoint,
      options: s.search?.options,
      maxResults: s.search?.maxResults ?? 10,
    },
    timeout: s.timeout ?? 15_000,
    maxBytes: s.maxBytes ?? 2_000_000,
    pageChars: s.pageChars ?? 20_000,
    redirects: s.redirects ?? 4,
    readsPerTurn: s.readsPerTurn ?? 8,
    ports: new Set([80, 443, ...(s.ports ?? [])]),
    userAgent: s.userAgent ?? USER_AGENT,
    resolve: s.resolve,
  };
}
