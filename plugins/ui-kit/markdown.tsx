/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
"use client";
/** The one Markdown renderer: GFM, highlighting, math and the URL policy. @module */
import * as React from "react";
import { memo, useEffect, useMemo, useReducer, useState } from "react";
import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Check, Copy } from "lucide-react";
import { markdownUrlPolicy } from "@copilotz/copilotz/web";
import { cn } from "./utils.ts";

type Plugins = NonNullable<Options["remarkPlugins"]>;
type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

// Math (KaTeX) and code highlighting are the heaviest parts of Markdown, so
// they load on first use. Until then math shows its source and code shows
// plain, in boxes of the same shape, so nothing moves when they arrive.
let mathPlugin: RehypePlugin | undefined;
let highlightPlugin: RehypePlugin | undefined;
let mathLoad: Promise<void> | undefined;
let highlightLoad: Promise<void> | undefined;
let prefetched = false;

function loadMath(): Promise<void> {
  return mathLoad ??= import("./markdown-math.ts").then((module) => {
    mathPlugin = module.mathPlugin;
  }, (cause) => {
    mathLoad = undefined; // A later render tries again.
    throw cause;
  });
}

function loadHighlight(): Promise<void> {
  return highlightLoad ??= import("./markdown-highlight.ts").then(
    (module) => {
      highlightPlugin = module.highlightPlugin;
    },
    (cause) => {
      highlightLoad = undefined;
      throw cause;
    },
  );
}

/**
 * Load math and code highlighting now; `Markdown` otherwise loads each on
 * first use. Server rendering and tests await it to render them at once.
 */
export function preloadMarkdown(): Promise<void> {
  return Promise.all([loadMath(), loadHighlight()]).then(() => {});
}

const MATH = /\$/;

/** Replaces `\( … \)` and `\[ … \]` in one piece of prose (not code). */
function prose(text: string): string {
  // Display math on lines of its own becomes a `$$` block, indented as the
  // line was (so it stays inside a list item); elsewhere it stays inline.
  const display = text.replace(
    /(^|\n)([ \t]*)\\\[([\s\S]+?)\\\][ \t]*(?=\n|$)/g,
    // A blank line before the block, so it never joins the paragraph above.
    (_match, start: string, indent: string, body: string) =>
      `${start}${start ? "\n" : ""}${indent}$$\n${
        body.trim().split("\n").map((line) => `${indent}${line.trim()}`)
          .join("\n")
      }\n${indent}$$`,
  ).replace(
    /\\\[([\s\S]+?)\\\]/g,
    (_match, body: string) => `$$${body.trim()}$$`,
  );
  return display.replace(
    /\\\(([\s\S]+?)\\\)/g,
    (_match, body: string) => `$${body.trim()}$`,
  );
}

/**
 * LLMs often write math as `\( … \)` and `\[ … \]`, which Markdown reads as
 * escaped brackets. They become `$ … $` and `$$ … $$`, so the one math path
 * (KaTeX, no `trust`) renders them; fenced and inline code stay untouched.
 */
export function normalizeMathDelimiters(source: string): string {
  if (!/\\[([]/.test(source)) return source;
  let out = "", fence: string | null = null, chunk = "";
  const flush = () => {
    // Inline code spans keep their text; only the prose around them changes.
    out += chunk.split(/(`+[^`]*?`+)/).map((part, index) =>
      index % 2 ? part : prose(part)
    ).join("");
    chunk = "";
  };
  for (const line of source.split(/(?<=\n)/)) {
    const marker = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      out += line;
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
    } else if (marker) {
      flush();
      fence = marker;
      out += line;
    } else chunk += line;
  }
  flush();
  return out;
}
const FENCE = /(^|\n)\s*(```|~~~)/;

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

function MathSource(
  { children, display }: { children?: React.ReactNode; display: boolean },
): React.ReactElement {
  return display
    ? (
      <div data-slot="math-pending" className="math-pending-display">
        {children}
      </div>
    )
    : <span data-slot="math-pending" className="math-pending">{children}</span>;
}

/**
 * Raw HTML is discarded, math renders with KaTeX (its fonts come with the kit
 * stylesheet; it loads on first use) and code is escaped text,
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
    const source = useMemo(() => normalizeMathDelimiters(children), [
      children,
    ]);
    const math = MATH.test(source);
    const highlighted = !streaming && FENCE.test(source);
    const [, loaded] = useReducer((count: number) => count + 1, 0);
    useEffect(() => {
      let live = true;
      const loads = [
        ...(math && !mathPlugin ? [loadMath()] : []),
        ...(highlighted && !highlightPlugin ? [loadHighlight()] : []),
      ];
      if (loads.length) {
        Promise.all(loads).then(() => live && loaded(), () => {});
      }
      if (!prefetched) {
        // Once any Markdown is on screen, fetch the rest when idle.
        prefetched = true;
        const idle = (globalThis as {
          requestIdleCallback?: (callback: () => void) => unknown;
        }).requestIdleCallback ??
          ((callback: () => void) => setTimeout(callback, 2000));
        idle(() => void preloadMarkdown().catch(() => {}));
      }
      return () => {
        live = false;
      };
    }, [math, highlighted]);
    const katex = math ? mathPlugin : undefined;
    const highlight = highlighted ? highlightPlugin : undefined;
    const rehypePlugins = useMemo(
      () =>
        [
          ...(katex ? [katex] : []),
          ...(highlight ? [highlight] : []),
          ...(plugins ?? []).flatMap((plugin) => plugin.rehypePlugins ?? []),
        ] as NonNullable<Options["rehypePlugins"]>,
      [katex, highlight, plugins],
    );
    return (
      <div
        data-slot="markdown"
        data-streaming={streaming || undefined}
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
            pre: ({ children }) => {
              const code = React.Children.toArray(children).find(
                React.isValidElement,
              ) as React.ReactElement<{ className?: string }> | undefined;
              // Display math waiting for KaTeX is not a code block.
              return /\bmath-display\b/.test(code?.props.className ?? "")
                ? <>{children}</>
                : <CodeBlock>{children}</CodeBlock>;
            },
            table: ({ children }) => (
              <div data-slot="table">
                <table>{children}</table>
              </div>
            ),
            code: ({ children, className }) =>
              /\bmath-(inline|display)\b/.test(className ?? "")
                ? (
                  <MathSource display={/\bmath-display\b/.test(className!)}>
                    {children}
                  </MathSource>
                )
                : <code className={className}>{children}</code>,
          }}
        >
          {source}
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
