/**
 * The computers plugin's settings (the `computers` resource): which work an
 * agent asks its person before doing (`approve`: running commands, starting
 * jobs, writing files), how long a connection code lasts, and where computers
 * connect (`url`: the app's address as a computer reaches it, which the
 * connect command names; `http(s)://` for the web host's socket, or a
 * `ws(s)://` socket as is).
 */
import type { Resources } from "../../../../runtime/mod.ts";

/**
 * Work that may need a person's yes. Publishing what a space's folder serves
 * as an app (the apps plugin) is always asked, whatever `approve` says: it
 * reaches outside the computer.
 */
export type Asked = "terminal" | "jobs" | "writes" | "publish";

export type ComputersSettings = {
  approve?: Exclude<Asked, "publish">[];
  codeMinutes?: number;
  url?: string;
};

export const settingsOf = (ctx: { resources: Resources }) => {
  const set = (ctx.resources.computers ?? {}) as ComputersSettings;
  // An org of a host serving many is reached under its own path (`/o/<org>`).
  const base = (ctx.resources.org as { base?: string } | undefined)?.base ?? "";
  return {
    approve: set.approve ?? ["terminal", "jobs", "writes"],
    codeMinutes: set.codeMinutes ?? 10,
    url: set.url ? set.url.replace(/\/+$/, "") + base : undefined,
  };
};
