/**
 * The computers plugin's settings (the `computers` resource): which work an
 * agent asks its person before doing (`approve`: running commands, starting
 * jobs, writing files), how long a connection code lasts, and where computers
 * connect (`url`: the app's address as a computer reaches it, which the
 * connect command names; `http(s)://` for the web host's socket, or a
 * `ws(s)://` socket as is).
 *
 * `previews`: what jobs serve, at `https://<id>-preview.<domain>/` (see
 * resources/previews.ts): the user-content domain (`copilotz.app`, never the
 * app's own: content there could set cookies the app trusts), the secret
 * the links that let people in are signed with (`key`), and the app's
 * address where people sign in (`app`; its `url` when that's `http(s)`).
 */
import type { Resources } from "../../../../runtime/mod.ts";

/** Work that may need a person's yes. */
export type Asked = "terminal" | "jobs" | "writes";

export type PreviewsSettings = { domain: string; key: string; app?: string };

export type ComputersSettings = {
  approve?: Asked[];
  codeMinutes?: number;
  url?: string;
  previews?: PreviewsSettings;
};

export const settingsOf = (ctx: { resources: Resources }) => {
  const set = (ctx.resources.computers ?? {}) as ComputersSettings;
  // An org of a host serving many is reached under its own path (`/o/<org>`).
  const base = (ctx.resources.org as { base?: string } | undefined)?.base ?? "";
  const app = set.previews?.app ?? (/^https?:\/\//.test(set.url ?? "") ? set.url : undefined);
  return {
    approve: set.approve ?? ["terminal", "jobs", "writes"],
    codeMinutes: set.codeMinutes ?? 10,
    url: set.url ? set.url.replace(/\/+$/, "") + base : undefined,
    previews: set.previews?.domain && set.previews.key
      ? {
        domain: set.previews.domain.toLowerCase(),
        key: set.previews.key,
        // Where the app is, under the org's own path when it's one of many.
        ...(app ? { app: app.replace(/\/+$/, "") + base } : {}),
      }
      : undefined,
  };
};
