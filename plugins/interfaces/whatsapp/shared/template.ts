/**
 * Template messages, as the plugin sends them: one the app declares (the
 * `whatsappTemplates` resource), its parameters checked against its body
 * and filled in, as the Graph API takes it, and as chats show it. A
 * number's fallback is one too, its `{name}` and `{text}` filled first.
 */
import { failure, type Resources } from "../../../../runtime/mod.ts";
import type { WaTemplate } from "./graph.ts";
import { type TemplateSend, templatesOf, type WhatsAppTemplate } from "./settings.ts";

/** The longest a template's body may be, filled, as Meta takes it. */
const BODY = 1024;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * A template's parameters, as its body names them: numbered ones in their
 * order, or named ones as they first appear (`named`).
 */
export function placeholdersOf(body: string): { names: string[]; named: boolean } {
  const names = [...new Set([...body.matchAll(PLACEHOLDER)].map(([, name]) => name))];
  const named = names.some((name) => !/^\d+$/.test(name));
  return { names: named ? names : names.sort((a, b) => Number(a) - Number(b)), named };
}

/**
 * What's wrong with a template as the app declares it: its name, language
 * and body; parameters numbered from 1 with none missed, or all named.
 * Undefined when nothing is.
 */
export function wrongIn(template: WhatsAppTemplate | undefined): string | undefined {
  for (const field of ["name", "language", "body"] as const) {
    if (typeof template?.[field] !== "string" || !template[field].trim()) {
      return `needs its ${field}`;
    }
  }
  const { names, named } = placeholdersOf(template!.body);
  if (named && names.some((name) => /^\d+$/.test(name))) {
    return "names its parameters or numbers them, not both";
  }
  if (!named && names.some((name, i) => Number(name) !== i + 1)) {
    return "numbers its parameters from {{1}}, missing none";
  }
  return undefined;
}

/**
 * A parameter as Meta takes one: on one line, with no tabs and never more
 * than four spaces in a row.
 */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const invalid = (message: string) => failure("invalid", message, { public: true });

/**
 * A template to send, made: what goes to Meta (`wire`) and what the chat
 * shows (`text`, its body filled). Its parameters must be the body's, each
 * saying something; the body's go in `params`, never in `components`.
 */
export function templateOf(
  ctx: { resources: Resources },
  send: TemplateSend,
): { wire: WaTemplate; text: string } {
  const template = templatesOf(ctx)[send.template];
  if (!template) {
    throw failure(
      "not_found",
      `No WhatsApp template "${send.template}": the app declares its templates ` +
        "(the whatsappTemplates resource).",
      { public: true },
    );
  }
  const { names, named } = placeholdersOf(template.body);
  const given = send.params ?? [];
  const values = Array.isArray(given)
    ? Object.fromEntries(given.map((value, i) => [names[i] ?? `${i + 1}`, value]))
    : given;
  const listed = names.map((name) => `{{${name}}}`).join(", ") || "none";
  const extra = Object.keys(values).filter((name) => !names.includes(name));
  const valueOf = (name: string) =>
    Object.hasOwn(values, name) ? oneLine(String(values[name])) : "";
  const missing = names.filter((name) => !valueOf(name));
  if (extra.length || missing.length) {
    throw invalid(
      `The template "${send.template}" takes ${names.length} parameter` +
        `${names.length === 1 ? "" : "s"} (${listed}), each saying something.`,
    );
  }
  if (send.components?.some((c) => String(c?.type).toLowerCase() === "body")) {
    throw invalid("A template's body parameters go in `params`, not in its components.");
  }
  const filled = names.map(valueOf);
  const body = names.length
    ? [{
      type: "body",
      parameters: names.map((name, i) => ({
        type: "text",
        ...(named ? { parameter_name: name } : {}),
        text: filled[i],
      })),
    }]
    : [];
  const components = [...body, ...send.components ?? []];
  return {
    wire: {
      type: "template",
      name: template.name,
      language: template.language,
      ...(components.length ? { components } : {}),
    },
    text: template.body.replace(PLACEHOLDER, (_, name: string) => filled[names.indexOf(name)]),
  };
}

/**
 * A number's fallback, for a message that found Meta's 24 hours past: its
 * parameters' `{name}` (the phone's WhatsApp name) and `{text}` (what the
 * message said, cut to what the body has room for) filled, then made.
 */
export function fallbackOf(
  ctx: { resources: Resources },
  fallback: TemplateSend,
  said: { name: string; text: string },
): { wire: WaTemplate; text: string } {
  const fill = (text: string) => (value: string) =>
    value.replace(/\{(name|text)\}/g, (_, which) => which === "name" ? said.name : text);
  const params = (text: string) =>
    Array.isArray(fallback.params)
      ? fallback.params.map(fill(text))
      : fallback.params
      ? Object.fromEntries(Object.entries(fallback.params).map(([k, v]) => [k, fill(text)(v)]))
      : undefined;
  const at = (text: string) =>
    templateOf(ctx, { ...fallback, ...(fallback.params ? { params: params(text) } : {}) });
  const words = oneLine(said.text) || "…";
  // How often the words show in the body, and the room it leaves them.
  const marked = at(MARK).text;
  const uses = marked.split(MARK).length - 1;
  const room = uses ? Math.floor((BODY - marked.length + uses) / uses) : Infinity;
  return at(words.length <= room ? words : `${words.slice(0, Math.max(0, room - 1)).trimEnd()}…`);
}

/** Stands for a message's words, to measure a body without them. */
const MARK = "\u0001";
