/**
 * A message as mail servers take it (RFC 5322, with MIME): its headers, then
 * one part, or several: text and HTML as alternatives to each other, files
 * beside them (`multipart/mixed`). Every line is ASCII, ending in CRLF, 76
 * characters at most, so any server takes it as it is:
 *
 * - **Headers:** what isn't ASCII is said as encoded words (RFC 2047:
 *   `=?UTF-8?B?…?=`), a file's name as RFC 2231 says (`filename*=`); long
 *   ones fold. Nothing in one ends a line: `email.send` refuses that.
 * - **Text and HTML:** quoted-printable, in UTF-8.
 * - **Files:** base64, as they came. A file with an `id` is inline (a
 *   `Content-ID`, `Content-Disposition: inline`): it goes with the HTML in a
 *   `multipart/related`, which `cid:id` there points to.
 * - **Injection:** a header's value is one line; a CR or LF in an address,
 *   the subject, a file's name, type or id makes `mime` throw.
 */
import type { EmailAttachment, EmailMessage } from "../contract.ts";
import { addressOf, nameOf } from "./addresses.ts";

const encoder = new TextEncoder();
const CRLF = "\r\n";
const ASCII = /^[\x20-\x7e]*$/;

const base64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};

/** Lines of 76 at most. */
const wrapped = (text: string) => text.replace(/(.{76})(?=.)/g, `$1${CRLF}`);

/** Words for a header: as they are when they're ASCII, else encoded words of 30 bytes each at most. */
function encodedWords(text: string): string {
  if (ASCII.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const c of text) {
    if (encoder.encode(chunk + c).length > 30) {
      words.push(chunk);
      chunk = "";
    }
    chunk += c;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${base64(encoder.encode(w))}?=`).join(`${CRLF} `);
}

/** A header, folded at spaces past 76 characters (an encoded value folds itself). */
function header(name: string, value: string): string {
  const line = `${name}: ${value}`;
  if (line.length <= 76 || value.includes(CRLF)) return line;
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    if (current && current.length + 1 + word.length > 76) {
      out.push(current);
      current = ` ${word}`;
    } else current = current ? `${current} ${word}` : word;
  }
  return [...out, current].join(CRLF);
}

/** An address with its name, as a header says it: `"Ana Lima" <ana@example.com>`. */
function mailbox(text: string): string {
  const address = addressOf(text);
  const name = nameOf(text);
  if (!name) return address;
  const said = ASCII.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodedWords(name);
  return `${said} <${address}>`;
}

/** Text as quoted-printable (RFC 2045), in UTF-8: lines kept, each 76 at most. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n|\r|\n/g, "\n").split("\n");
  return lines.map((line) => {
    const bytes = encoder.encode(line);
    let out = "";
    let width = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      const piece = plain
        ? String.fromCharCode(b)
        : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
      // A soft break before what wouldn't fit (75, leaving room for its `=`).
      if (width + piece.length > 75) {
        out += `=${CRLF}`;
        width = 0;
      }
      out += piece;
      width += piece.length;
    }
    return out;
  }).join(CRLF);
}

/** A file's type, by its name's ending when it doesn't say. */
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  json: "application/json",
  xml: "application/xml",
  zip: "application/zip",
  ics: "text/calendar",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export const typeOf = (filename: string): string =>
  TYPES[filename.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** A file's name as a parameter: quoted ASCII, else RFC 2231's `filename*=UTF-8''…`. */
const filename = (name: string) =>
  ASCII.test(name) && !/["\\]/.test(name)
    ? `filename="${name}"`
    : `filename*=UTF-8''${
      encodeURIComponent(name).replace(
        /['()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      )
    }`;

/** A part: its headers, a blank line, its body. */
const part = (headers: string[], body: string) => `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;

/** Parts as one: each after its boundary, then the closing one. */
const multipart = (boundary: string, parts: string[]) =>
  parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join("") + `--${boundary}--`;

/** What makes a boundary: none of it ever shows in quoted-printable or base64 (`=_`). */
const boundaryOf = () =>
  `=_copilotz_${
    [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }`;

/** Throws when a value that goes in a header has a line break (it would start another header). */
function oneLine(what: string, value: string | undefined): void {
  if (value !== undefined && /[\r\n]/.test(value)) {
    throw new Error(`MIME: ${what} can't hold a line break`);
  }
}

/** A message's source, from `from`, and its id (`<…@domain>`). */
export function mime(
  message: EmailMessage,
  from: string,
  options: { date?: Date; replyTo?: string } = {},
): { source: string; id: string } {
  oneLine("from", from);
  oneLine("to", message.to);
  oneLine("subject", message.subject);
  oneLine("replyTo", message.replyTo ?? options.replyTo);
  for (const file of message.attachments ?? []) {
    oneLine("a file's name", file.filename);
    oneLine("a file's type", file.contentType);
    oneLine("a file's id", file.id);
  }
  const domain = addressOf(from).split("@")[1] || "localhost";
  const id = `<${crypto.randomUUID()}@${domain}>`;
  const text = part([
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
  ], quotedPrintable(message.text));
  const files = message.attachments ?? [];
  const inline = files.filter((file) => file.id);
  const beside = files.filter((file) => !file.id);
  if (inline.length && !message.html) {
    throw new Error("MIME: an inline file (with an id) needs an html body that points to it");
  }
  const filePart = (file: EmailAttachment) =>
    part([
      `Content-Type: ${file.contentType ?? typeOf(file.filename)}`,
      "Content-Transfer-Encoding: base64",
      ...(file.id ? [`Content-ID: <${file.id}>`] : []),
      header(
        "Content-Disposition",
        `${file.id ? "inline" : "attachment"}; ${filename(file.filename)}`,
      ),
    ], wrapped(file.content.replace(/\s+/g, "")));
  let html = message.html
    ? part([
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
    ], quotedPrintable(message.html))
    : undefined;
  if (html && inline.length) {
    const boundary = boundaryOf();
    html = part(
      [`Content-Type: multipart/related;${CRLF} boundary="${boundary}"`],
      multipart(boundary, [html, ...inline.map(filePart)]),
    );
  }
  let body = text;
  if (html) {
    const boundary = boundaryOf();
    body = part(
      [`Content-Type: multipart/alternative;${CRLF} boundary="${boundary}"`],
      multipart(boundary, [text, html]),
    );
  }
  if (beside.length) {
    const boundary = boundaryOf();
    body = part(
      [`Content-Type: multipart/mixed;${CRLF} boundary="${boundary}"`],
      multipart(boundary, [body, ...beside.map(filePart)]),
    );
  }
  const date = (options.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000");
  const replyTo = message.replyTo ?? options.replyTo;
  const headers = [
    header("From", mailbox(from)),
    header("To", mailbox(message.to)),
    ...(replyTo ? [header("Reply-To", mailbox(replyTo))] : []),
    header("Subject", encodedWords(message.subject)),
    `Date: ${date}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
  ];
  return { source: `${headers.join(CRLF)}${CRLF}${body}${CRLF}`, id };
}
