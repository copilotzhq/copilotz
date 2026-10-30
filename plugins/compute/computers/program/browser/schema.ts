/**
 * The browser's actions as an agent asks for them (sandbox-lite's agent
 * contract): the first sixteen names are its public ones; the rest were added
 * after. A request is a batch of 1–10, at most 48 KiB, in who's browser,
 * hidden or shown (`window`); who it's for comes from the scope, never from
 * here.
 */

export const BROWSER_ACTIONS = [
  "navigate",
  "click",
  "type",
  "read",
  "screenshot",
  "evaluate",
  "wait",
  "mouseMove",
  "mouseClick",
  "scroll",
  "keyPress",
  "web_search",
  "snapshot",
  "close",
  "download",
  "upload",
  "fill",
  "back",
  "forward",
  "reload",
  "tabs",
  "dialog",
  "control",
] as const;

export type BrowserAction = typeof BROWSER_ACTIONS[number];

/** A browser request's JSON Schema, without its scope (the plugin adds that). */
export const browserInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
    stopOnError: { type: "boolean" },
    window: {
      enum: ["hidden", "shown"],
      description:
        "Hidden, or shown on the person's screen (they can watch and use it): switching keeps " +
        "the profile and the page. Unless given, it stays as it is; it starts hidden.",
    },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      description: "Browser actions, done in order; download and upload use the space's folder.",
      items: {
        type: "object",
        required: ["action"],
        properties: { action: { type: "string", enum: BROWSER_ACTIONS } },
      },
    },
  },
  description: "At most 48 KiB.",
} as const;

/** What a browser request answers. */
export const browserOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["success", "stoppedEarly", "window", "results"],
  properties: {
    success: { type: "boolean" },
    stoppedEarly: { type: "boolean" },
    currentUrl: { type: "string" },
    title: { type: "string" },
    window: { enum: ["hidden", "shown"] },
    results: { type: "array", items: {} },
  },
} as const;
