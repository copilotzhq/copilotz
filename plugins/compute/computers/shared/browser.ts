/**
 * The browser tool as agents see it: each action and its fields (so a model
 * knows `navigate` takes a `url` and `click` a `ref` from `snapshot`), and the
 * window, hidden or shown on the person's screen. The computer program reads
 * the same request (`BrowserInput`, program/browser/schema.ts).
 */

const target = "the element: a ref from snapshot (preferred), or a CSS selector";

/** One action: its name, and the fields the actions that take them use. */
export const browserActionSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: [
        "navigate",
        "snapshot",
        "read",
        "click",
        "type",
        "fill",
        "keyPress",
        "scroll",
        "wait",
        "screenshot",
        "back",
        "forward",
        "reload",
        "tabs",
        "dialog",
        "download",
        "upload",
        "evaluate",
        "mouseMove",
        "mouseClick",
        "web_search",
        "close",
      ],
    },
    url: { type: "string", description: "navigate, tabs new: where to go." },
    ref: {
      type: "string",
      description: `click, type, fill, read, screenshot, download, upload: ${target}.`,
    },
    selector: {
      type: "string",
      description: "Instead of ref: a CSS selector; wait: what to wait for.",
    },
    text: { type: "string", description: "type, fill: what to enter; dialog: a prompt's answer." },
    clear: { type: "boolean", description: "type: clear the field first." },
    key: { type: "string", description: 'keyPress: a key, like "Enter", "Tab", "Escape".' },
    deltaY: { type: "number", description: "scroll: pixels down (negative: up)." },
    deltaX: { type: "number", description: "scroll: pixels right." },
    until: {
      enum: ["load", "domcontentloaded", "networkidle", "selector"],
      description: "wait: what to wait for (selector: until it's there).",
    },
    waitUntil: {
      enum: ["load", "domcontentloaded", "networkidle", "commit"],
      description: "navigate: when it's done (default load).",
    },
    maxChars: { type: "integer", description: "read: the most text to return." },
    fullPage: {
      type: "boolean",
      description: "screenshot: the whole page (default), or the view.",
    },
    operation: { enum: ["list", "new", "select", "close"], description: "tabs: what to do." },
    tabId: { type: "string", description: "tabs select, close: which tab." },
    accept: { type: "boolean", description: "dialog: accept (or dismiss) the open dialog." },
    path: {
      type: "string",
      description: "download: where to save it; upload: the file; in the space's folder.",
    },
    expression: { type: "string", description: "evaluate: JavaScript run in the page." },
    x: { type: "number", description: "mouseMove, mouseClick: from the page's left." },
    y: { type: "number", description: "mouseMove, mouseClick: from the page's top." },
    button: { enum: ["left", "right", "middle"], description: "mouseClick." },
    query: { type: "string", description: "web_search: what to search for." },
    timeoutMs: { type: "integer", description: "This action's time limit." },
  },
} as const;

export const browserDescription =
  "Uses your browser on your person's computer: one of your own for this space, with its own " +
  "profile (never their personal browser), so sign-ins stay between calls. One to ten actions " +
  "per call, in order. Start with navigate, then snapshot: it lists the page's elements with " +
  "refs to click, type into or read. " +
  'The window is hidden unless you ask for "shown": then it opens on their screen, where they ' +
  "can watch and use it too. Show it when a site won't work hidden, or when they need to see " +
  "or do something themselves (sign in, a CAPTCHA, a code): tell them what, then wait for " +
  'them before going on, and hide it ("hidden") when you no longer need them.';
