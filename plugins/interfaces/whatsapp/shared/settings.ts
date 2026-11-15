/**
 * The WhatsApp plugin's settings (the `whatsapp` resource): the numbers the
 * app declares, by name, as a flat map. Each is a number opened from the
 * app's settings, with no person connecting it. And the template messages
 * Meta approved for its numbers (the `whatsappTemplates` resource), by the
 * app's name for each.
 */
import type { Resources } from "../../../../runtime/mod.ts";

/**
 * A template message Meta approved, as the app declares it: its name and
 * language there, and its body as approved. Past Meta's 24 hours since a
 * phone last wrote, a template is all that reaches it.
 */
export type WhatsAppTemplate = {
  /** Meta's name for it, as approved: `order_update`. */
  name: string;
  /** Its language, as Meta's code says it: `pt_BR`, `en_US`. */
  language: string;
  /**
   * Its body, as approved, its parameters where they go: numbered (`{{1}}`,
   * `{{2}}`…) or named (`{{customer}}`). What chats show of it, filled.
   */
  body: string;
};

/**
 * The `whatsappTemplates` resource: the template messages the app's numbers
 * send, by the app's name for each (`resources.whatsappTemplates.<name>`).
 */
export type WhatsAppTemplatesSettings = Record<string, WhatsAppTemplate>;

/**
 * A template to send, by the app's name for it: its body's parameters, in
 * order (`["Ana", "1234"]`) or by name (`{ customer: "Ana" }`), and Meta's
 * own components besides its body (a header's picture, a button's
 * parameters), as the Graph API takes them.
 */
export type TemplateSend = {
  template: string;
  params?: string[] | Record<string, string>;
  components?: Record<string, unknown>[];
};

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
  /**
   * The template that goes in a message's place once Meta's 24 hours since
   * the phone last wrote are past: one of `whatsappTemplates`, whose
   * parameters may say `{name}` (the phone's WhatsApp name) and `{text}`
   * (what the message said). Without it, that message stays in the app
   * (`window_closed`).
   */
  fallback?: TemplateSend;
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

/** The templates the app declares, by its name for each. */
export const templatesOf = (ctx: { resources: Resources }): WhatsAppTemplatesSettings =>
  Object.fromEntries(
    Object.entries((ctx.resources.whatsappTemplates ?? {}) as WhatsAppTemplatesSettings)
      .filter(([, template]) => template),
  );
