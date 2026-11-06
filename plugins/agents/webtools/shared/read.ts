/**
 * Reading a page: the URL checked, fetched through `ctx.fetch` by hand
 * (redirects are followed one at a time, each address checked again), within
 * a time, a size and a kind of content, and turned into text.
 */
import { failure } from "../../../../runtime/mod.ts";
import type { WebToolsContext } from "../contract.ts";
import { allowed } from "./address.ts";
import { settingsOf } from "./settings.ts";
import { readable } from "./text.ts";

export type Page = {
  url: string;
  title: string;
  text: string;
  links: { text: string; url: string }[];
};

const HTML = /^(text\/html|application\/xhtml\+xml)$/i;
const PLAIN = /^(text\/(plain|markdown|csv|xml)|application\/(json|xml|[a-z.+-]+\+(json|xml)))$/i;

/** Reads at most `max` bytes; more is an error rather than a cut page. */
async function bytesOf(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  const tooBig = () =>
    failure("too_large", `The page is larger than ${(max / 1e6).toFixed(0)} MB; it isn't read`);
  if (declared > max) throw tooBig();
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw tooBig();
      parts.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const part of parts) all.set(part, at), at += part.byteLength;
  return all;
}

export async function fetchPage(
  ctx: WebToolsContext & Pick<WebToolsContext, "signal">,
  address: string,
): Promise<Page> {
  const s = settingsOf(ctx);
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw failure("invalid", `"${address}" isn't a URL`);
  }
  const stop = new AbortController();
  let late = false;
  const timer = setTimeout(() => (late = true, stop.abort()), s.timeout);
  const cancel = () => stop.abort(ctx.signal.reason);
  if (ctx.signal.aborted) cancel();
  else ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    for (let hops = 0;; hops++) {
      if (!/^https?:$/.test(url.protocol)) {
        throw failure("invalid", "Only http and https pages are read");
      }
      if (url.username || url.password) {
        throw failure("invalid", "A URL with a password isn't read");
      }
      const port = url.port ? +url.port : url.protocol === "https:" ? 443 : 80;
      if (!s.ports.has(port)) {
        throw failure("forbidden", `Port ${port} isn't one pages are read on`);
      }
      await allowed(url, s.resolve);
      const response = await ctx.fetch(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: {
          "user-agent": s.userAgent,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1",
        },
        signal: stop.signal,
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        response.body?.cancel().catch(() => {});
        if (hops >= s.redirects) {
          throw failure("too_large", `The page redirects more than ${s.redirects} times`);
        }
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        throw failure("unreachable", `${url.host} answered HTTP ${response.status}`);
      }
      const type = (response.headers.get("content-type") ?? "").split(";")[0].trim();
      const html = HTML.test(type), plain = PLAIN.test(type);
      if (!html && !plain) {
        response.body?.cancel().catch(() => {});
        throw failure(
          "invalid",
          `The page is ${type || "of unknown type"}: only web pages and text are read`,
        );
      }
      const charset = /charset=["']?([\w-]+)/i.exec(response.headers.get("content-type") ?? "")
        ?.[1];
      const bytes = await bytesOf(response, s.maxBytes);
      let text: string;
      try {
        text = new TextDecoder(charset ?? "utf-8").decode(bytes);
      } catch {
        text = new TextDecoder().decode(bytes);
      }
      if (!html) return { url: url.href, title: "", text: text.trim(), links: [] };
      return { url: url.href, ...readable(text, url) };
    }
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
    if (late) throw failure("timeout", `${url.host} didn't answer within ${s.timeout / 1000} s`);
    if (typeof (error as { code?: unknown }).code === "string") throw error;
    throw failure("unreachable", `Couldn't reach ${url.host}: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", cancel);
  }
}
