/**
 * WhatsApp's parts: what a `whatsapp.*` View returns is a list of parts,
 * each one WhatsApp message (text, buttons, a list, a carousel, an image, a
 * document), built with these functions. Each checks Meta's limits and
 * throws `invalid`, saying what's wrong: nothing is cut short silently, as
 * ids and counts must be right (`clip` shortens a title on purpose).
 *
 * ```ts
 * buttons("Pay with PIX or card?", [{ id: "pay:pix", title: "PIX" }, { id: "pay:card", title: "Card" }])
 * carousel("Some trips for 12/11", trips.map((t) => ({
 *   image: { link: t.picture }, body: `${t.time} ${t.company}`, buttons: [{ id: `trip:${t.id}`, title: "Choose" }],
 * })))
 * ```
 */
import { invalid } from "../../../../runtime/mod.ts";
import { LIMIT } from "./text.ts";

/**
 * A picture or a file to send: a `file` document of the chat (slice 3), a
 * public https address as it is, or a signed link to one of the app's routes.
 */
export type WaMedia =
  | { file: string }
  | { link: string }
  | { route: string; params: Record<string, string> };

/** A choice someone taps: what comes back (`id`) and what they read (`title`). */
export type Choice = { id: string; title: string };
export type Row = Choice & { description?: string };
export type Section = { title?: string; rows: Row[] };
export type Card = { image: WaMedia; body?: string; buttons: Choice[] };

export type WaPart =
  | { type: "text"; text: string }
  | {
    type: "buttons";
    text: string;
    buttons: Choice[];
    header?: string | WaMedia;
    footer?: string;
  }
  | {
    type: "list";
    text: string;
    button: string;
    sections: Section[];
    header?: string;
    footer?: string;
  }
  | { type: "carousel"; text: string; cards: Card[] }
  | { type: "image"; image: WaMedia; caption?: string }
  | { type: "document"; document: WaMedia; filename: string; caption?: string };

/** How much text each part carries, at most: its body, or its caption. */
export const BODY: Record<WaPart["type"], number> = {
  text: LIMIT,
  buttons: 1024,
  list: 4096,
  carousel: 1024,
  image: 1024,
  document: 1024,
};

const fail = (what: string) => {
  throw invalid(`WhatsApp: ${what}`);
};

/** Throws unless `value` is text of 1 to `max` characters (or empty, when it may be). */
function sized(what: string, value: unknown, max: number, empty = false) {
  if (typeof value !== "string") fail(`${what} must be text.`);
  const text = value as string;
  if (!text.trim() && !empty) fail(`${what} is empty.`);
  if (text.length > max) fail(`${what} is ${text.length} characters: at most ${max}.`);
}

/** Throws unless every id is set, within `max`, and different from the others. */
function unique(what: string, choices: { id: string }[], max: number) {
  const seen = new Set<string>();
  for (const { id } of choices) {
    sized(`${what} id`, id, max);
    if (seen.has(id)) fail(`${what} id "${id}" is used twice.`);
    seen.add(id);
  }
}

function media(what: string, value: WaMedia) {
  if ("link" in value) {
    if (!/^https:\/\/\S+$/.test(value.link)) fail(`${what} must be a public https link.`);
  } else if ("file" in value) sized(`${what} file`, value.file, 200);
  else if ("route" in value) sized(`${what} route`, value.route, 100);
  else fail(`${what} is a file, a link or a route.`);
}

/** `text`, cut to `max` characters with an ellipsis when it's longer: for titles. */
export const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

export function text(body: string): WaPart {
  sized("A text", body, LIMIT);
  return { type: "text", text: body };
}

/** Up to three buttons under a text (with a header, text or a picture, and a footer). */
export function buttons(
  body: string,
  choices: Choice[],
  more: { header?: string | WaMedia; footer?: string } = {},
): WaPart {
  sized("Buttons' text", body, BODY.buttons);
  if (choices.length < 1 || choices.length > 3) fail("Buttons are 1 to 3.");
  for (const c of choices) sized("A button's title", c.title, 20);
  unique("A button's", choices, 256);
  if (typeof more.header === "string") sized("Buttons' header", more.header, 60);
  else if (more.header) media("Buttons' header", more.header);
  if (more.footer !== undefined) sized("Buttons' footer", more.footer, 60);
  return {
    type: "buttons",
    text: body,
    buttons: choices,
    ...(more.header ? { header: more.header } : {}),
    ...(more.footer ? { footer: more.footer } : {}),
  };
}

/** A list someone opens with `button`, of up to ten rows in all, in sections. */
export function list(
  body: string,
  button: string,
  sections: Section[],
  more: { header?: string; footer?: string } = {},
): WaPart {
  sized("A list's text", body, BODY.list);
  sized("A list's button", button, 20);
  if (sections.length < 1 || sections.length > 10) fail("A list has 1 to 10 sections.");
  const rows = sections.flatMap((s) => s.rows);
  if (rows.length < 1 || rows.length > 10) fail("A list has 1 to 10 rows in all.");
  if (sections.length > 1 && sections.some((s) => !s.title)) {
    fail("A list of several sections titles each one.");
  }
  for (const s of sections) if (s.title !== undefined) sized("A section's title", s.title, 24);
  for (const r of rows) {
    sized("A row's title", r.title, 24);
    if (r.description !== undefined) sized("A row's description", r.description, 72);
  }
  unique("A row's", rows, 200);
  if (more.header !== undefined) sized("A list's header", more.header, 60);
  if (more.footer !== undefined) sized("A list's footer", more.footer, 60);
  return {
    type: "list",
    text: body,
    button,
    sections,
    ...(more.header ? { header: more.header } : {}),
    ...(more.footer ? { footer: more.footer } : {}),
  };
}

/**
 * Cards side by side, each a picture (a public https link: Meta takes no
 * uploaded one here), a short text and its quick replies (1 to 3, as many
 * on each).
 */
export function carousel(body: string, cards: Card[]): WaPart {
  sized("A carousel's text", body, BODY.carousel);
  if (cards.length < 2 || cards.length > 10) fail("A carousel has 2 to 10 cards.");
  const count = cards[0].buttons.length;
  for (const [i, card] of cards.entries()) {
    media(`Card ${i + 1}'s picture`, card.image);
    if (card.body !== undefined) {
      sized(`Card ${i + 1}'s text`, card.body, 160);
      if ((card.body.match(/\n/g) ?? []).length > 2) {
        fail(`Card ${i + 1}'s text has over 2 breaks.`);
      }
    }
    if (card.buttons.length < 1 || card.buttons.length > 3) {
      fail(`Card ${i + 1} has 1 to 3 quick replies.`);
    }
    if (card.buttons.length !== count) fail("Every card has as many quick replies.");
    for (const b of card.buttons) sized(`Card ${i + 1}'s reply title`, b.title, 20);
  }
  unique("A quick reply's", cards.flatMap((c) => c.buttons), 256);
  return { type: "carousel", text: body, cards };
}

/** A picture (jpeg or png, up to 5 MB), with a caption. */
export function image(picture: WaMedia, caption?: string): WaPart {
  media("An image", picture);
  if (caption !== undefined) sized("An image's caption", caption, BODY.image, true);
  return { type: "image", image: picture, ...(caption ? { caption } : {}) };
}

/** A file (up to 100 MB) by its name, with a caption. */
export function document(file: WaMedia, filename: string, caption?: string): WaPart {
  media("A document", file);
  sized("A document's file name", filename, 240);
  if (caption !== undefined) sized("A document's caption", caption, BODY.document, true);
  return { type: "document", document: file, filename, ...(caption ? { caption } : {}) };
}

/** What a part says in text: its body or caption (what an answer before it joins). */
export const wordsIn = (part: WaPart): string =>
  part.type === "image" || part.type === "document" ? part.caption ?? "" : part.text;

/**
 * Text before a part (an answer), as one message with it when the part can
 * say it (its body or caption has room): undefined when it can't. The answer
 * is the body: a part's own words are what it says without one (a question
 * the answer asks already), unless they're kept (`keep`: a text, or a
 * fallback, where they're what's shown).
 */
export function joined(
  before: string,
  part: WaPart,
  keep = part.type === "text",
): WaPart | undefined {
  const own = keep ? wordsIn(part) : "";
  const words = own ? `${before}\n\n${own}` : before;
  if (words.length > BODY[part.type]) return undefined;
  return part.type === "image" || part.type === "document"
    ? { ...part, caption: words }
    : { ...part, text: words };
}
