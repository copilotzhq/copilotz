/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
// deno-lint-ignore verbatim-module-syntax -- classic JSX requires this runtime import.
import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownUrlPolicy } from "@copilotz/copilotz/web";

export interface MarkdownProps {
  children: string;
  /**
   * Further origins whose images may load, such as `https://cdn.example`.
   * Relative and same-origin images always load.
   */
  imageOrigins?: readonly string[];
}

function pageOrigin(): string | undefined {
  try {
    return globalThis.location?.origin;
  } catch {
    return undefined; // Hosts without a page location load relative images only.
  }
}

/**
 * Raw HTML is discarded and code remains text. URLs follow
 * `markdownUrlPolicy`: unsafe links are dropped, links open in a new tab
 * without a referrer, and an image that may not load renders as its alt text
 * and is never fetched.
 */
export function Markdown(
  { children, imageOrigins }: MarkdownProps,
): React.ReactElement | null {
  const policy = markdownUrlPolicy({ origin: pageOrigin(), imageOrigins });
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert">
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        urlTransform={policy.urlTransform}
        components={{
          a: ({ children, href }) => (
            <a href={href} {...policy.linkAttributes}>{children}</a>
          ),
          img: ({ src, alt }) =>
            src ? <img src={src} alt={alt ?? ""} loading="lazy" /> : (
              <span
                data-slot="blocked-image"
                className="text-muted-foreground"
              >
                {alt || "Image not loaded"}
              </span>
            ),
          code: ({ children, className }) => (
            <code className={className}>{children}</code>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
