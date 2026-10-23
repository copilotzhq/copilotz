/**
 * Renderer-independent URL policy for Markdown from messages and other
 * untrusted text. Any Markdown component can apply it; nothing here reads
 * browser globals.
 * @module
 */
export interface MarkdownUrlPolicyOptions {
  /** The page origin, from the host. Relative and same-origin images load. */
  readonly origin?: string;
  /** Further origins whose images may load, such as `https://cdn.example`. */
  readonly imageOrigins?: readonly string[];
}
export interface MarkdownUrlPolicy {
  /**
   * A safe URL, or "" to drop it. `href` keeps relative URLs and http(s),
   * mailto, xmpp and irc(s) links. Every other attribute fetches without a
   * click, so it keeps only an image URL that `loadsImage` allows. The
   * signature matches react-markdown's `urlTransform`.
   */
  urlTransform(url: string, key: string): string;
  /** Whether an image may load: relative, same-origin or an allowed origin. */
  loadsImage(url: string): boolean;
  /** Attributes for every rendered link: a new tab, no opener, no referrer. */
  readonly linkAttributes: Readonly<{
    target: "_blank";
    rel: "noopener noreferrer nofollow";
  }>;
}

const linkProtocol = /^(https?|ircs?|mailto|xmpp)$/i;
const linkAttributes = Object.freeze(
  {
    target: "_blank",
    rel: "noopener noreferrer nofollow",
  } as const,
);
/** Same rule as micromark's sanitizer: no scheme, or a scheme on the list. */
function safeLink(url: string): boolean {
  const colon = url.indexOf(":");
  const before = (mark: string) => {
    const index = url.indexOf(mark);
    return index !== -1 && colon > index;
  };
  return colon === -1 || before("/") || before("?") || before("#") ||
    linkProtocol.test(url.slice(0, colon));
}
function webOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function markdownUrlPolicy(
  options: MarkdownUrlPolicyOptions = {},
): MarkdownUrlPolicy {
  // Without a page origin only relative images resolve to this base.
  const base = new URL(webOrigin(options.origin) ?? "https://markdown.invalid");
  const allowed = new Set(
    (options.imageOrigins ?? []).map(webOrigin).filter((origin) => origin),
  );
  const loadsImage = (url: string) => {
    if (!url || !safeLink(url)) return false;
    let target: URL;
    try {
      target = new URL(url, base);
    } catch {
      return false;
    }
    return (target.protocol === "https:" || target.protocol === "http:") &&
      (target.origin === base.origin || allowed.has(target.origin));
  };
  return {
    urlTransform: (url, key) =>
      (key === "href" ? safeLink(url) : loadsImage(url)) ? url : "",
    loadsImage,
    linkAttributes,
  };
}
