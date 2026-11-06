/**
 * Files people sent, as chat serves them (`GET /files/<id>`, its route): an
 * image's picture, a voice message's sound, a download. Each is read as
 * whoever the request is (chat's `file.content` query), so the rules decide
 * who gets it: nobody signed in, or a file out of their reach, is a 404 alike.
 *
 * - **Ranges:** `Range: bytes=…` answers with that part (206), which Safari
 *   needs to play audio and seek it.
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
import { linksOf, type Route, verifyLink } from "../../../../runtime/mod.ts";

/** Where files are served. */
export const FILES = "/files/";

type Sent = { name: string; type: string; data: string };

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

/** Base64 to bytes, with web standards only. */
const bytesOf = (data: string) => Uint8Array.from(atob(data), (c) => c.charCodeAt(0));

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
  const file = id && (system || someone)
    ? await runtime.query<Sent | null>("file.content", { id }, someone ? { actor: someone } : {})
      .catch(() => null)
    : null;
  if (!file) return missing();
  const bytes = bytesOf(file.data);
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
  const part = range(request.headers.get("range"), bytes.length);
  if (part === null) {
    return new Response(null, {
      status: 416,
      headers: { ...headers, "content-range": `bytes */${bytes.length}` },
    });
  }
  const [start, end] = part ?? [0, bytes.length - 1];
  const body = bytes.subarray(start, end + 1);
  return new Response(request.method === "HEAD" ? null : body as BodyInit, {
    status: part ? 206 : 200,
    headers: {
      ...headers,
      "content-length": String(body.length),
      ...(part ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
    },
  });
};
