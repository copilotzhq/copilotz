/**
 * The WhatsApp plugin's settings (the `whatsapp` resource): the numbers the
 * app declares, by name, as a flat map. Each is a number opened from the
 * app's settings, with no person connecting it.
 */
import type { Resources } from "../../../../runtime/mod.ts";

/**
 * A number the app declares: open to anyone, kept as its settings say at
 * every use (no person connects it, nor changes it).
 */
export type DeclaredNumber = {
  /**
   * The space its customers' chats live in: one the app declares too (the
   * spaces plugin's `spaces` resource) is made and kept with the number.
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
   * another path to the plugin's `hookRoute` (its `routes` field).
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
};

/** The `whatsapp` resource: the declared numbers, by name. */
export type WhatsAppSettings = Record<string, DeclaredNumber>;

/** Where Meta's Graph API is. Tests replace `fetch` (`createRuntime({ fetch })`), not this. */
export const GRAPH = "https://graph.facebook.com/v23.0";

/** Minutes a code to link a phone lasts. */
export const CODE_MINUTES = 15;

/** What chat takes as a file, at most: 10 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** The numbers the app declares, by name. */
export const numbersOf = (ctx: { resources: Resources }): WhatsAppSettings =>
  Object.fromEntries(
    Object.entries((ctx.resources.whatsapp ?? {}) as WhatsAppSettings).filter(([, number]) =>
      number
    ),
  );
