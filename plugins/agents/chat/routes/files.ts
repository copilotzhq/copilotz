/**
 * Files people sent, as chat serves them (`GET /files/<id>`, its route): an
 * image's picture, a voice message's sound, a download. Each is read as
 * whoever the request is, so the rules decide who gets it: nobody signed in,
 * or a file out of their reach, is a 404 alike.
 *
 * - **Streamed, of any size:** what the file is comes first, from chat's
 *   `file.about` query (its name and type, never its content), as whoever
 *   the request is. Then its content, from the owner itself
 *   (`runtime.bytes`, read as them again), decoded from base64 a part at a
 *   time as the response is read. Nothing carries the file whole: a query's
 *   answer comes from an executor in one piece, over Oxian, no way to move
 *   megabytes. Nor does the blob's reference ever reach this route: the
 *   owner takes it from the document its own read found, and hands over
 *   bytes.
 * - **Ranges:** `Range: bytes=…` answers with that part (206), which Safari
 *   needs to play audio and seek it; only that part is decoded.
 * - **Inline or saved:** images, audio, video and PDFs show where they're
 *   linked; anything else, or any file with `?download=1`, is saved under its
 *   name.
 * - **Nothing runs:** every answer says `nosniff` and a sandboxed policy, so a
 *   file opened on its own (an SVG, an HTML page someone sent) runs no script.
 * - **Kept privately:** a file never changes once sent; a browser may keep it,
 *   a shared cache may not.
 * - **A signed link** (`/files/<id>?exp=…&sig=…`, the runtime's `signLink`
 *   with the app's `links` secret) is served without anyone signed in, as
 *   the system: code that could read the file signed it, to send it on
 *   (WhatsApp fetches a picture from it). Expired or altered, it's a 404.
 */
import { type Bytes, linksOf, type Route, verifyLink } from "../../../../runtime/mod.ts";
import type { FileAbout } from "../collections/file.ts";

/** Where files are served. */
export const FILES = "/files/";

/**
 * How many bytes a part of the response holds: whole groups of base64 (three
 * bytes from four characters), 192 KiB from 256 KiB stored.
 */
export const PART = 3 * 64 * 1024;

const SAFE = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
};

/** Shown where linked; anything else is saved. */
const inline = (type: string) => /^(image|audio|video)\//.test(type) || type === "application/pdf";

/** A media type as sent, if it's one; else bytes. */
const typeOf = (type: string) =>
  /^[\w.+-]+\/[\w.+-]+(;\s*[\w.+-]+=[\w.+-]+)*$/.test(type) ? type : "application/octet-stream";

const missing = () =>
  new Response("Not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...SAFE },
  });

/** What reading a file it can't reach answers: nothing, as for a file that isn't there. */
const OUT_OF_REACH = new Set(["forbidden", "not_found", "invalid", "unauthorized"]);
const unreached = (error: unknown) => {
  if (OUT_OF_REACH.has((error as { code?: string })?.code ?? "")) return null;
  throw error;
};

/** The part a `Range` header asks for, inclusive; null: none it can have; undefined: no range. */
function range(header: string | null, size: number): [number, number] | null | undefined {
  const asked = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!header) return undefined;
  if (!asked || (!asked[1] && !asked[2])) return null;
  const [start, end] = asked[1]
    ? [Number(asked[1]), asked[2] ? Math.min(Number(asked[2]), size - 1) : size - 1]
    : [Math.max(size - Number(asked[2]), 0), size - 1];
  return start <= end && start < size ? [start, end] : null;
}

const EQUALS = 61; // "="

/** How many bytes base64 `content` holds: three for each four characters, less its padding. */
async function sizeOf(content: Bytes): Promise<number> {
  const tail = await content.read(Math.max(content.size - 2, 0), content.size);
  const padding = tail.at(-1) === EQUALS ? (tail.at(-2) === EQUALS ? 2 : 1) : 0;
  return Math.floor((content.size - padding) * 3 / 4);
}

/** Base64 to bytes, with web standards only. */
const bytesOf = (data: string) => {
  const text = atob(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
};

/**
 * Bytes `start` up to `end` (not included) of base64 `content`, decoded a
 * part at a time as the response is read: each part from the groups of four
 * characters that hold it, so nothing before `start` is decoded, and no more
 * than a part is held at once.
 */
function decoded(content: Bytes, start: number, end: number): ReadableStream<Uint8Array> {
  const text = new TextDecoder();
  let at = start;
  return new ReadableStream({
    async pull(controller) {
      if (at >= end) return controller.close();
      const to = Math.min(at + PART, end);
      const [first, last] = [Math.floor(at / 3), Math.ceil(to / 3)];
      const chars = await content.read(first * 4, Math.min(last * 4, content.size));
      const bytes = bytesOf(text.decode(chars));
      controller.enqueue(bytes.subarray(at - first * 3, to - first * 3));
      at = to;
    },
  });
}

/** `GET` and `HEAD /files/<id>`, as whoever the request is, or by a link signed for the file. */
export const serveFile: Route = async (request, { runtime, actor }) => {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") return missing();
  let id: string;
  try {
    id = decodeURIComponent(url.pathname.slice(FILES.length));
  } catch {
    return missing();
  }
  // The app's links (the runtime checks them as it starts: a secret too short stops it).
  const links = linksOf(runtime.describe().resources);
  /** Whether a request is a link signed for its file: then the system reads it. */
  const signed = async () => {
    if (!url.searchParams.has("sig")) return false;
    const query = Object.fromEntries(url.searchParams);
    delete query.download;
    return !!links && !!await verifyLink(links, url.pathname, query);
  };
  const system = id ? await signed() : false;
  const someone = !system && actor.kind !== "anonymous" ? actor : undefined;
  if (!id || !(system || someone)) return missing();
  const as = someone ? { actor: someone } : {};
  // What it is, as chat's query lets them read it (who may ask, and the rules).
  const file = await runtime.query<FileAbout | null>("file.about", { id }, as).catch(unreached);
  if (!file) return missing();
  // Its content, read by the owner as them again: the rules decide once more, and the blob read
  // is the one this document names, as the store holds it.
  const content = await runtime.bytes("file", { _id: id }, "data", as).catch(unreached);
  if (!content) return missing();
  const size = await sizeOf(content);
  const type = typeOf(file.type);
  const saved = url.searchParams.get("download") === "1" || !inline(type);
  const headers: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": `${saved ? "attachment" : "inline"}; filename*=UTF-8''${
      encodeURIComponent(file.name)
    }`,
    ...SAFE,
  };
  const part = range(request.headers.get("range"), size);
  if (part === null) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${size}` },
    });
  }
  const [start, end] = part ?? [0, size - 1];
  const length = end - start + 1;
  return new Response(
    request.method === "HEAD" || !length ? null : decoded(content, start, end + 1),
    {
      status: part ? 206 : 200,
      headers: {
        ...headers,
        "content-length": String(length),
        ...(part ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      },
    },
  );
};
