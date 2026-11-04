/**
 * The WhatsApp plugin's settings (the `whatsapp` resource): where Meta's
 * Graph API is (its version; a test's fake), how long a code to link a
 * phone lasts, the largest file a message may bring, and the app's own
 * customer lines (`lines`), by name: numbers it opens from its settings,
 * with no person connecting them.
 */
import type { Resources } from "../../../../runtime/mod.ts";

/**
 * A customer line the app declares: a number open to anyone, kept as its
 * settings say at every use (no person connects it, nor changes it).
 */
export type WhatsAppLine = {
  /**
   * The space its customers' chats live in: one the app declares too (the
   * spaces plugin's `spaces` resource) is made and kept with the line.
   */
  in: string;
  /** Meta's id for the number, its access token, and the Meta app's secret (signing its webhook). */
  phoneId: string;
  token: string;
  secret: string;
  /** What Meta shows to check its webhook, the app's own. */
  verify: string;
  /**
   * Where its webhook is: `/hooks/whatsapp/<name>` unless the app routes
   * another path to `whatsapp.hook` (its `routes` resource).
   */
  path?: string;
  /**
   * Who answers its customers; a quiet chat's hours; messages a minute;
   * seconds a burst may go on before the answer; customers' language.
   */
  agent?: string;
  gap?: number;
  rate?: number;
  quiet?: number;
  language?: "en" | "pt";
  /** The number as people dial it, and the business's name, as shown. */
  phone?: string;
  name?: string;
  /** With the orgs host, the org it's for (its id): no other org has it. */
  org?: string;
};

export type WhatsAppSettings = {
  graph?: string;
  codeMinutes?: number;
  maxFileMb?: number;
  lines?: Record<string, WhatsAppLine>;
};

/**
 * The app's own lines, by name, here: with the orgs host (each org's runtime
 * knows its org, `resources.org`), only those that name this org (`org`); a
 * line naming none is the single-org app's. An org never answers, nor
 * writes, another's line.
 */
export const linesOf = (ctx: { resources: Resources }): Record<string, WhatsAppLine> => {
  const all = ((ctx.resources.whatsapp ?? {}) as WhatsAppSettings).lines ?? {};
  const org = (ctx.resources.org as { id?: string } | undefined)?.id;
  return Object.fromEntries(
    Object.entries(all).filter(([, line]) => line && (org ? line.org === org : !line.org)),
  );
};

export const settingsOf = (ctx: { resources: Resources }) => {
  const set = (ctx.resources.whatsapp ?? {}) as WhatsAppSettings;
  return {
    graph: (set.graph ?? "https://graph.facebook.com/v23.0").replace(/\/+$/, ""),
    codeMinutes: set.codeMinutes ?? 15,
    // What chat takes as a file, at most.
    maxFileBytes: Math.min(set.maxFileMb ?? 10, 10) * 1024 * 1024,
  };
};
