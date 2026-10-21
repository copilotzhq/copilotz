/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** The one Markdown renderer: GFM, highlighting, math and the URL policy. @module */
import * as React from "react";
import { memo, useMemo, useState } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy } from "lucide-react";
import { markdownUrlPolicy } from "@copilotz/copilotz/web";
import { cn } from "./utils.ts";

type Plugins = NonNullable<Options["remarkPlugins"]>;

/**
 * Extra unified plugins an app contributes through
 * `adapters.markdown.<alias>`. Plugins run after the built-in ones; raw HTML
 * stays disabled and URLs still pass the policy.
 */
export interface MarkdownPlugin {
  remarkPlugins?: Plugins;
  rehypePlugins?: NonNullable<Options["rehypePlugins"]>;
}

export interface MarkdownProps {
  children: string;
  /**
   * Further origins whose images may load, such as `https://cdn.example`.
   * Relative and same-origin images always load.
   */
  imageOrigins?: readonly string[];
  /** App plugins, see `markdownPlugins(ctx)`. */
  plugins?: readonly MarkdownPlugin[];
  /** A message still streaming: code is not highlighted until it settles. */
  streaming?: boolean;
  /** `chat` is the message body size; `default` is ordinary prose. */
  variant?: "chat" | "default";
  className?: string;
}

function pageOrigin(): string | undefined {
  try {
    return globalThis.location?.origin;
  } catch {
    return undefined; // Hosts without a page location load relative images only.
  }
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement(node)) {
    return textOf((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

function CodeBlock(
  { children }: { children?: React.ReactNode },
): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const code = React.Children.toArray(children).find(React.isValidElement) as
    | React.ReactElement<{ className?: string; children?: React.ReactNode }>
    | undefined;
  const language = /language-([\w+-]+)/.exec(code?.props.className ?? "")
    ?.[1];
  const clipboard = (globalThis as {
    navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
  }).navigator?.clipboard;
  return (
    <div data-slot="code-block" className="not-prose group/code relative my-3">
      <div className="bg-(--code-background) text-(--code-foreground) overflow-hidden rounded-md border border-(--code-border)">
        <div className="flex h-8 items-center justify-between border-b border-(--code-border) px-3 text-[11px] text-(--code-comment)">
          <span className="font-mono">{language ?? "text"}</span>
          {clipboard && (
            <button
              type="button"
              aria-label={copied ? "Copied" : "Copy code"}
              className="hover:text-(--code-foreground) focus-visible:ring-ring/45 inline-flex items-center gap-1 rounded px-1 py-0.5 outline-none focus-visible:ring-[3px]"
              onClick={() =>
                clipboard.writeText(textOf(code?.props.children)).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }, () =>
                  setCopied(false))}
            >
              {copied
                ? <Check aria-hidden="true" className="size-3.5" />
                : <Copy aria-hidden="true" className="size-3.5" />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          )}
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed">
          {children}
        </pre>
      </div>
    </div>
  );
}

const remarkBuiltIns: Plugins = [remarkGfm, remarkMath];
const katex = [rehypeKatex, { output: "mathml", throwOnError: false }] as const;
const highlight = [rehypeHighlight, { detect: false }] as const;

/**
 * Raw HTML is discarded, math renders as MathML and code is escaped text,
 * highlighted once a message settles. URLs follow `markdownUrlPolicy`: unsafe
 * links are dropped, links open in a new tab without a referrer, and an image
 * that may not load renders as its alt text and is never fetched.
 */
export const Markdown: React.NamedExoticComponent<MarkdownProps> = memo(
  function Markdown(
    {
      children,
      imageOrigins,
      plugins,
      streaming = false,
      variant = "default",
      className,
    }: MarkdownProps,
  ): React.ReactElement | null {
    const policy = useMemo(
      () => markdownUrlPolicy({ origin: pageOrigin(), imageOrigins }),
      [imageOrigins?.join(" ")],
    );
    const remarkPlugins = useMemo(
      () => [
        ...remarkBuiltIns,
        ...(plugins ?? []).flatMap((plugin) => plugin.remarkPlugins ?? []),
      ],
      [plugins],
    );
    const highlighted = !streaming && /(^|\n)\s*(```|~~~)/.test(children);
    const rehypePlugins = useMemo(
      () =>
        [
          katex,
          ...(highlighted ? [highlight] : []),
          ...(plugins ?? []).flatMap((plugin) => plugin.rehypePlugins ?? []),
        ] as NonNullable<Options["rehypePlugins"]>,
      [highlighted, plugins],
    );
    return (
      <div
        data-slot="markdown"
        className={cn(
          "prose prose-sm max-w-none break-words",
          variant === "chat" && "prose-chat",
          className,
        )}
      >
        <ReactMarkdown
          skipHtml
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
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
            pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
            code: ({ children, className }) => (
              <code className={className}>{children}</code>
            ),
          }}
        >
          {children}
        </ReactMarkdown>
      </div>
    );
  },
);

const contributedPlugins = new WeakMap<object, readonly MarkdownPlugin[]>();

/**
 * App Markdown plugins from `ctx.adapters.markdown`, in alias order. The
 * result is stable for one adapter set, so memoized Markdown stays memoized.
 */
export function markdownPlugins(
  adapters: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): readonly MarkdownPlugin[] {
  const cached = contributedPlugins.get(adapters);
  if (cached) return cached;
  const contributed = adapters.markdown ?? {};
  const plugins = Object.keys(contributed).sort().map((alias) =>
    contributed[alias] as MarkdownPlugin
  ).filter((plugin) =>
    plugin && typeof plugin === "object" &&
    (Array.isArray(plugin.remarkPlugins) || Array.isArray(plugin.rehypePlugins))
  );
  contributedPlugins.set(adapters, plugins);
  return plugins;
}
