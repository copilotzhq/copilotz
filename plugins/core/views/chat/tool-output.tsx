/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/**
 * A tool call's input and result: structured values as a readable,
 * collapsible tree, text as text, each copyable, with calm empty states.
 * @module
 */
import * as React from "react";
import { useState } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import {
  cn,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@copilotz/copilotz/web/kit";

type Json =
  | string
  | number
  | boolean
  | null
  | readonly Json[]
  | { readonly [key: string]: Json };

/** Children shown per level before "Show more". */
const PAGE = 50;
/** A container this short (as JSON) stays on one line. */
const INLINE = 56;
/** Strings longer than this fold behind "Show all". */
const LONG_STRING = 280;

/** Plain JSON data: functions, symbols and cycles become strings. */
export function toJson(value: unknown, seen = new Set<unknown>()): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => toJson(item, seen));
    if (value instanceof Date) return value.toISOString();
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map((
        [key, item],
      ) => [key, toJson(item, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

/** A JSON object or array within text, parsed; anything else is text. */
export function parseStructured(text: string): Json | undefined {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return undefined;
  try {
    const value = JSON.parse(trimmed) as Json;
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

function stringify(value: Json): string {
  return JSON.stringify(value, null, 2) ?? "null";
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** "3 items", "5 fields", "Empty list", "128 characters". */
export function describeJson(value: Json): string {
  if (Array.isArray(value)) {
    return value.length ? plural(value.length, "item") : "Empty list";
  }
  if (value && typeof value === "object") {
    const size = Object.keys(value).length;
    return size ? plural(size, "field") : "Empty object";
  }
  if (typeof value === "string") {
    return value ? plural(value.length, "character") : "Empty text";
  }
  return value === null ? "Nothing returned" : typeof value;
}

/** Whether a value carries nothing to look at. */
export function isEmptyJson(value: Json): boolean {
  return value === null || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value as object).length === 0);
}

const emptyNotes = (value: Json): string =>
  Array.isArray(value)
    ? "No items. The tool returned an empty list."
    : value === null
    ? "Nothing returned."
    : typeof value === "string"
    ? "The tool returned no text."
    : "No fields. The tool returned an empty object.";

function isContainer(value: Json): value is readonly Json[] | {
  readonly [key: string]: Json;
} {
  return Boolean(value) && typeof value === "object";
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function Key({ name }: { name: string | number }): React.ReactElement {
  return typeof name === "number"
    ? (
      <span className="text-muted-foreground/70 select-none tabular-nums">
        {name}:{" "}
      </span>
    )
    : (
      <span className="text-foreground font-medium">
        {IDENTIFIER.test(name) ? name : JSON.stringify(name)}
        <span className="text-muted-foreground">:</span>
        {" "}
      </span>
    );
}

function LongString({ value }: { value: string }): React.ReactElement {
  const [all, setAll] = useState(false);
  const long = value.length > LONG_STRING;
  return (
    <span className="text-success break-words whitespace-pre-wrap">
      "{long && !all ? `${value.slice(0, LONG_STRING)}…` : value}"
      {long && (
        <button
          type="button"
          onClick={() => setAll((open) => !open)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/45 ml-1.5 rounded font-sans text-[11px] underline-offset-2 outline-none hover:underline focus-visible:ring-[3px]"
        >
          {all ? "Show less" : `Show all ${value.length.toLocaleString()}`}
        </button>
      )}
    </span>
  );
}

function Primitive({ value }: { value: Json }): React.ReactElement {
  if (typeof value === "string") return <LongString value={value} />;
  if (typeof value === "number") {
    return <span className="text-info tabular-nums">{String(value)}</span>;
  }
  if (typeof value === "boolean") {
    return <span className="text-warning">{String(value)}</span>;
  }
  return <span className="text-muted-foreground italic">null</span>;
}

/** A short container on one line: `{ limit: 20 }`, `["a", "b"]`. */
function Inline({ value }: { value: Json }): React.ReactElement {
  if (!isContainer(value)) return <Primitive value={value} />;
  const array = Array.isArray(value);
  const entries = array
    ? (value as readonly Json[]).map((item, index) => [index, item] as const)
    : Object.entries(value);
  if (!entries.length) {
    return <span className="text-muted-foreground">{array ? "[]" : "{}"}</span>;
  }
  return (
    <span>
      <span className="text-muted-foreground">{array ? "[" : "{ "}</span>
      {entries.map(([key, item], index) => (
        <React.Fragment key={key}>
          {!array && <Key name={key} />}
          <Inline value={item} />
          {index < entries.length - 1 && (
            <>
              <span className="text-muted-foreground">,</span>
              {" "}
            </>
          )}
        </React.Fragment>
      ))}
      <span className="text-muted-foreground">{array ? "]" : " }"}</span>
    </span>
  );
}

function fitsInline(value: Json): boolean {
  if (!isContainer(value)) return true;
  const text = JSON.stringify(value);
  return text.length <= INLINE && !/\\n/.test(text);
}

type Entry = readonly [string | number, Json];

function entriesOf(value: Json): readonly Entry[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => [index, item] as const);
  }
  return isContainer(value) ? Object.entries(value) : [];
}

/** A folded node's one-line preview: `{ id: "n7", text: "Ana pre…", … }`. */
export function previewJson(value: Json, budget = 96): string {
  if (typeof value === "string") {
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  }
  if (!isContainer(value)) return String(value);
  const array = Array.isArray(value);
  const entries = entriesOf(value);
  const parts: string[] = [];
  let used = 0;
  for (const [key, item] of entries) {
    if (used > budget) break;
    const shown = isContainer(item)
      ? Array.isArray(item) ? `[${item.length}]` : "{…}"
      : previewJson(item);
    const part = array ? shown : `${key}: ${shown}`;
    parts.push(part);
    used += part.length + 2;
  }
  const more = parts.length < entries.length ? ", …" : "";
  return array
    ? `[${parts.join(", ")}${more}]`
    : `{ ${parts.join(", ")}${more} }`;
}

/** Nodes this small (as JSON) start open near the top of the tree. */
const OPEN_SIZE = 1_200;

/** A level's children, a page at a time. */
function Entries(
  { entries, depth }: { entries: readonly Entry[]; depth: number },
): React.ReactElement {
  const [shown, setShown] = useState(PAGE);
  return (
    <>
      {entries.slice(0, shown).map(([key, item]) => (
        <TreeNode key={key} name={key} value={item} depth={depth} />
      ))}
      {entries.length > shown && (
        <div className="pl-4">
          <button
            type="button"
            onClick={() => setShown((count) => count + PAGE * 4)}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/45 rounded font-sans text-[11px] underline-offset-2 outline-none hover:underline focus-visible:ring-[3px]"
          >
            Show {Math.min(PAGE * 4, entries.length - shown)} more of{" "}
            {entries.length.toLocaleString()}
          </button>
        </div>
      )}
    </>
  );
}

function TreeNode(
  { name, value, depth }: {
    name: string | number;
    value: Json;
    depth: number;
  },
): React.ReactElement {
  const entries = entriesOf(value);
  // The first levels open; deep, wide or large nodes start folded.
  const [open, setOpen] = useState(() =>
    depth <= 2 && entries.length <= 12 &&
    (depth === 1 || JSON.stringify(value).length <= OPEN_SIZE)
  );
  if (!entries.length || fitsInline(value)) {
    return (
      <div className="pl-4 [overflow-wrap:anywhere]">
        <Key name={name} />
        <Inline value={value} />
      </div>
    );
  }
  const summary = Array.isArray(value)
    ? plural(entries.length, "item")
    : plural(entries.length, "field");
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} ${
          typeof name === "number" ? `item ${name}` : name
        }, ${summary}`}
        onClick={() => setOpen((value) => !value)}
        className="hover:bg-foreground/5 focus-visible:ring-ring/45 group/node -mx-1 flex max-w-[calc(100%+0.5rem)] min-w-0 items-center rounded-sm px-1 text-left outline-none focus-visible:ring-2"
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "text-muted-foreground group-hover/node:text-foreground size-3 shrink-0 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 truncate pl-1">
          <Key name={name} />
          <span className="text-muted-foreground font-sans text-[11px]">
            {summary}
          </span>
          {!open && (
            <span className="text-muted-foreground/80 pl-2">
              {previewJson(value)}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="border-border ml-1.5 border-l pl-1">
          <Entries entries={entries} depth={depth + 1} />
        </div>
      )}
    </div>
  );
}

/**
 * A JSON value as a readable tree: fields by name, nested values folding
 * past the first levels, short values on one line.
 */
export function JsonTree(
  { value, className }: { value: Json; className?: string },
): React.ReactElement {
  const entries = entriesOf(value);
  return (
    <div
      data-slot="json-tree"
      className={cn("font-mono text-xs leading-relaxed", className)}
    >
      {entries.length && !fitsInline(value)
        ? <Entries entries={entries} depth={1} />
        : (
          <div className="[overflow-wrap:anywhere]">
            <Inline value={value} />
          </div>
        )}
    </div>
  );
}

function CopyValue(
  { text, label }: { text: string; label: string },
): React.ReactElement | null {
  const [copied, setCopied] = useState(false);
  const clipboard = (globalThis as {
    navigator?: { clipboard?: { writeText(text: string): Promise<void> } };
  }).navigator?.clipboard;
  if (!clipboard || !text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={copied ? "Copied" : `Copy ${label.toLowerCase()}`}
          onClick={() =>
            clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }, () => setCopied(false))}
          className="text-muted-foreground hover:text-foreground hover:bg-foreground/5 focus-visible:ring-ring/45 inline-flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-[3px]"
        >
          {copied
            ? <Check aria-hidden="true" className="text-success size-3.5" />
            : <Copy aria-hidden="true" className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}

/**
 * One labelled part of a tool call (its input or its result): a caption
 * with a short description and Copy, over the value.
 */
export function ToolPayload(
  { label, value, text, tone = "default", describe = true, children }: {
    label: string;
    /** Whether the caption says what the value holds ("3 items"). */
    describe?: boolean;
    /** A structured value, shown as a tree. */
    value?: unknown;
    /** Text, shown as a tree when it is a JSON object or array. */
    text?: string;
    tone?: "default" | "error";
    /** A note in place of the value (loading, unavailable). */
    children?: React.ReactNode;
  },
): React.ReactElement {
  const structured = value !== undefined
    ? toJson(value)
    : text !== undefined
    ? parseStructured(text)
    : undefined;
  const plain = structured === undefined ? text : undefined;
  const copy = structured !== undefined ? stringify(structured) : plain ?? "";
  const meta = children || !describe
    ? undefined
    : structured !== undefined
    ? describeJson(structured)
    : plain !== undefined && !plain.trim()
    ? "Empty text"
    : undefined;
  const empty = structured !== undefined
    ? isEmptyJson(structured)
    : plain !== undefined && !plain.trim();
  return (
    <figure
      data-slot="tool-payload"
      data-tone={tone === "error" ? "error" : undefined}
      className={cn("grid min-w-0", tone === "error" && "bg-destructive/5")}
    >
      <figcaption className="flex h-7 min-w-0 items-center gap-2 pr-1.5 pl-3">
        <span
          className={cn(
            "text-xs font-medium",
            tone === "error" ? "text-destructive" : "text-foreground/80",
          )}
        >
          {label}
        </span>
        {meta && (
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {meta}
          </span>
        )}
        <span className="ml-auto flex items-center">
          {!children && !empty && <CopyValue text={copy} label={label} />}
        </span>
      </figcaption>
      <div className="max-h-80 overflow-auto px-3 pt-0.5 pb-2.5">
        {children ?? (empty
          ? (
            <p className="text-muted-foreground text-xs italic">
              {structured !== undefined
                ? emptyNotes(structured)
                : "The tool returned no text."}
            </p>
          )
          : structured !== undefined
          ? <JsonTree value={structured} />
          : (
            <pre
              className={cn(
                "text-xs leading-relaxed break-words whitespace-pre-wrap",
                tone === "error"
                  ? "text-destructive font-sans text-[13px]"
                  : "font-mono",
              )}
            >
              {plain}
            </pre>
          ))}
      </div>
    </figure>
  );
}
