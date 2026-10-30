/**
 * What the API offers in the command palette (kind `api.palette`, the web
 * shell's `palette` resource): in a space, its developer keys (its API tab),
 * found by what people call them: a key, a token, the API.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { PaletteGroup } from "../../../../../hosts/web/mod.ts";

export const apiPaletteView = (_: unknown, ctx: ViewContext<ReactNode>): PaletteGroup[] | null => {
  const here = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  if (!here) return null;
  return [{
    title: "This space",
    order: 10,
    items: [{
      key: "api:keys",
      label: "Developer keys",
      description: "Keys for your code to call the agents here",
      icon: "terminal",
      keywords: ["api", "key", "token", "developer", "curl", "integration", "webhook"],
      href: `/space/${encodeURIComponent(here)}?tab=api`,
    }],
  }];
};
