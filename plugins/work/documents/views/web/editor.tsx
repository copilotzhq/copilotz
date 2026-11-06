/// <reference lib="dom" />
/**
 * The writing surface: Markdown as it's written, in a field as tall as what
 * it holds (the page scrolls, as a document does), a small toolbar over it
 * (bold, italic, heading, lists, a task, a quote, code, a link) and the
 * shortcuts people know (⌘B, ⌘I, ⌘E, ⌘K on selected words, ⌘⇧7/8/9,
 * ⌘⌥1–3; Enter goes on with a list, Tab indents it; an address pasted over
 * words links them). Write, Preview (the toolkit's `Markdown`, as the page
 * reads) or both side by side (Split, where there's room, the preview
 * following the page's scroll). Every change goes in as typing would, so
 * undo undoes it.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  IconButton,
  Kbd,
  Markdown,
  Popover,
  Tabs,
  Textarea,
  Tooltip,
} from "../../../../../hosts/web/mod.ts";
import {
  type Change,
  enter,
  fence,
  type Field,
  heading,
  indent,
  lines,
  link,
  mark,
  pasted,
} from "./format.ts";
import { MOD, modded } from "./people.tsx";

export type Mode = "write" | "preview" | "split";

/** Makes a change in the field as typing would (undo undoes it), then selects what it says. */
export function apply(el: HTMLTextAreaElement, c: Change): void {
  el.focus();
  if (c.from === c.to && !c.insert) {
    el.setSelectionRange(c.select[0], c.select[1]);
    return;
  }
  el.setSelectionRange(c.from, c.to);
  const typed = c.insert
    ? document.execCommand("insertText", false, c.insert)
    : document.execCommand("delete");
  if (!typed || el.value.slice(c.from, c.from + c.insert.length) !== c.insert) {
    el.setRangeText(c.insert, c.from, c.to, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  el.setSelectionRange(c.select[0], c.select[1]);
}

const fieldOf = (el: HTMLTextAreaElement): Field => ({
  value: el.value,
  start: el.selectionStart,
  end: el.selectionEnd,
});

/** A toolbar button's drawing, on a 24 by 24 grid, in the text's colour. */
const GLYPHS = {
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M19 4h-9M14 20H5M15 4 9 20",
  heading: "M6 4v16M18 4v16M6 12h12",
  bullet: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  number: "M10 6h10M10 12h10M10 18h10M4 4h1.5v5M4 9h3M7 19H4c0-1.6 3-2.4 3-4a1.5 1.5 0 0 0-3 0",
  task: "M3.5 6.5 5 8l3-3M3.5 16.5 5 18l3-3M11 7h10M11 17h10",
  quote: "M4 6v12M9 8h11M9 12h11M9 16h7",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" +
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  keys: "M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8",
  history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
} as const;

/** A drawing of the editor's own (a tool, History), in the text's colour. */
export function Glyph(
  { name, size = 16 }: { name: keyof typeof GLYPHS; size?: number },
): ReactNode {
  return (
    <svg
      className="doc-glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={GLYPHS[name]} />
    </svg>
  );
}

type Tool = {
  key: keyof typeof GLYPHS;
  label: string;
  keys: string[];
  change(field: Field): Change | undefined;
};

/** The toolbar's tools, in order, each with its shortcut as it's shown. */
const TOOLS: (Tool | "|")[] = [
  { key: "bold", label: "Bold", keys: [MOD, "B"], change: (f) => mark(f, "bold") },
  { key: "italic", label: "Italic", keys: [MOD, "I"], change: (f) => mark(f, "italic") },
  {
    key: "heading",
    label: "Heading (again for a smaller one)",
    keys: [MOD, "⌥", "1–3"],
    change: heading,
  },
  "|",
  {
    key: "bullet",
    label: "Bulleted list",
    keys: [MOD, "⇧", "8"],
    change: (f) => lines(f, "bullet"),
  },
  {
    key: "number",
    label: "Numbered list",
    keys: [MOD, "⇧", "7"],
    change: (f) => lines(f, "number"),
  },
  { key: "task", label: "Checklist", keys: [MOD, "⇧", "9"], change: (f) => lines(f, "task") },
  { key: "quote", label: "Quote", keys: [MOD, "⇧", "."], change: (f) => lines(f, "quote") },
  "|",
  { key: "code", label: "Code", keys: [MOD, "E"], change: (f) => mark(f, "code") },
  { key: "link", label: "Link", keys: [MOD, "K"], change: (f) => link(f) },
];

/** What a key press does in the field, if it's a shortcut: the change to make. */
function shortcut(event: KeyboardEvent<HTMLTextAreaElement>, f: Field): Change | undefined {
  const mod = modded(event);
  const key = event.key.toLowerCase();
  if (mod && !event.altKey && !event.shiftKey) {
    if (key === "b") return mark(f, "bold");
    if (key === "i") return mark(f, "italic");
    if (key === "e") return mark(f, "code");
  }
  if (mod && event.shiftKey && !event.altKey) {
    if (event.code === "Digit7") return lines(f, "number");
    if (event.code === "Digit8") return lines(f, "bullet");
    if (event.code === "Digit9") return lines(f, "task");
    if (event.code === "Period") return lines(f, "quote");
    if (key === "x") return mark(f, "strike");
    if (event.code === "KeyC") return fence(f);
  }
  if (mod && event.altKey && !event.shiftKey) {
    if (event.code === "Digit1") return lines(f, "h1");
    if (event.code === "Digit2") return lines(f, "h2");
    if (event.code === "Digit3") return lines(f, "h3");
    if (event.code === "Digit0") return lines(f, "plain");
  }
  if (!mod && !event.altKey && event.key === "Enter" && !event.shiftKey) return enter(f);
  if (!mod && !event.altKey && event.key === "Tab") return indent(f, event.shiftKey);
  return undefined;
}

/** The shortcuts, as the help lists them. */
const KEYS: [string, string[]][] = [
  ["Save", [MOD, "S"]],
  ["Bold", [MOD, "B"]],
  ["Italic", [MOD, "I"]],
  ["Strikethrough", [MOD, "⇧", "X"]],
  ["Code", [MOD, "E"]],
  ["Code block", [MOD, "⇧", "C"]],
  ["Link (words selected)", [MOD, "K"]],
  ["Heading 1, 2, 3", [MOD, "⌥", "1–3"]],
  ["Plain text", [MOD, "⌥", "0"]],
  ["Bulleted list", [MOD, "⇧", "8"]],
  ["Numbered list", [MOD, "⇧", "7"]],
  ["Checklist", [MOD, "⇧", "9"]],
  ["Quote", [MOD, "⇧", "."]],
  ["Indent a list item", ["Tab"]],
  ["Outdent it", ["⇧", "Tab"]],
];

function Keys({ keys }: { keys: string[] }): ReactNode {
  return (
    <span className="doc-keys">
      {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
    </span>
  );
}

/** The toolbar: tools for the field, Write / Preview / Split, and the shortcuts. */
export function Toolbar(
  { field, mode, onMode, split, editing }: {
    field: RefObject<HTMLTextAreaElement | null>;
    mode: Mode;
    onMode(mode: Mode): void;
    /** Whether there's room side by side. */
    split: boolean;
    /** Whether the field shows (not Preview alone). */
    editing: boolean;
  },
): ReactNode {
  // On a phone, the tools take the row, and Preview is one button.
  const roomy = useWide(560);
  const use = (tool: Tool) => {
    const el = field.current;
    if (!el) return;
    const c = tool.change(fieldOf(el));
    if (c) apply(el, c);
  };
  return (
    <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
      <div className="doc-tools" data-off={!editing || undefined}>
        {TOOLS.map((tool, i) =>
          tool === "|" ? <span key={i} className="doc-tools-gap" aria-hidden="true" /> : (
            <Tooltip
              key={tool.key}
              text={
                <>
                  {tool.label} <Keys keys={tool.keys} />
                </>
              }
              describe={false}
            >
              <button
                type="button"
                className="doc-tool"
                aria-label={tool.label}
                disabled={!editing}
                // Keep the field's focus and selection (mouse, pen or touch): the tool works on it.
                onPointerDown={(event) => event.preventDefault()}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => use(tool)}
              >
                <Glyph name={tool.key} />
              </button>
            </Tooltip>
          )
        )}
        <span className="doc-tools-gap" aria-hidden="true" />
        <Popover
          label="Keyboard shortcuts"
          width={300}
          align="start"
          trigger={(props) => (
            <button {...props} type="button" className="doc-tool" aria-label="Keyboard shortcuts">
              <Glyph name="keys" />
            </button>
          )}
        >
          <div className="doc-help">
            <p className="doc-help-title">Keyboard shortcuts</p>
            <dl>
              {KEYS.map(([what, keys]) => (
                <div key={what}>
                  <dt>{what}</dt>
                  <dd>
                    <Keys keys={keys} />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="doc-help-note">
              Enter goes on with a list. Pasting a link over selected words links them.
            </p>
          </div>
        </Popover>
      </div>
      {roomy
        ? (
          <Tabs
            label="How it shows"
            className="doc-modes"
            value={mode === "split" && !split ? "write" : mode}
            onChange={onMode}
            tabs={[
              { value: "write" as const, label: "Write" },
              { value: "preview" as const, label: "Preview" },
              ...(split ? [{ value: "split" as const, label: "Split" }] : []),
            ]}
          />
        )
        : (
          <IconButton
            className="doc-mode-toggle"
            icon={mode === "preview" ? "pencil" : "eye"}
            label={mode === "preview" ? "Write" : "Preview"}
            variant={mode === "preview" ? "secondary" : "ghost"}
            aria-pressed={mode === "preview"}
            onClick={() => onMode(mode === "preview" ? "write" : "preview")}
          />
        )}
    </div>
  );
}

/** Where the page scrolls: the `Page` this is in. */
const scrollerOf = (el: Element | null) => el?.closest<HTMLElement>("[data-density=full]") ?? null;

/** Writing at the end of a long text: the end stays in sight as the field grows. */
function inSight(el: HTMLTextAreaElement) {
  if (el.selectionEnd < el.value.length - 1) return;
  requestAnimationFrame(() => {
    const page = scrollerOf(el);
    const bottom = el.getBoundingClientRect().bottom;
    const room = globalThis.visualViewport?.height ?? globalThis.innerHeight;
    if (page && bottom > room - 48) page.scrollTop += bottom - room + 96;
  });
}

/** The field, as tall as what it holds, and its shortcuts. */
export function Editor(
  { value, onChange, field, placeholder, label, mode }: {
    value: string;
    onChange(value: string): void;
    field: RefObject<HTMLTextAreaElement | null>;
    placeholder: string;
    label: string;
    mode: Mode;
  },
): ReactNode {
  const shown = useDeferredValue(value);
  const preview = useRef<HTMLDivElement>(null);
  const write = mode !== "preview";
  const read = mode !== "write";

  // ⌘K is the command palette's, everywhere; but on words selected here, as in other editors,
  // it links them. The shell hears ⌘K before anything else does, so this hears it first.
  useEffect(() => {
    const pressed = (event: globalThis.KeyboardEvent) => {
      const el = field.current;
      if (!el || globalThis.document.activeElement !== el || event.key.toLowerCase() !== "k") {
        return;
      }
      if (
        !modded(event) || event.altKey || event.shiftKey || el.selectionStart === el.selectionEnd
      ) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      apply(el, link(fieldOf(el)));
    };
    globalThis.addEventListener("keydown", pressed, true);
    return () => globalThis.removeEventListener("keydown", pressed, true);
  }, []);

  // Split: the preview follows the page's scroll, as far down as the field is.
  useEffect(() => {
    if (mode !== "split") return;
    const page = scrollerOf(field.current);
    const pane = preview.current;
    if (!page || !pane) return;
    const follow = () => {
      const most = page.scrollHeight - page.clientHeight;
      const ratio = most > 0 ? page.scrollTop / most : 0;
      pane.scrollTop = ratio * (pane.scrollHeight - pane.clientHeight);
    };
    page.addEventListener("scroll", follow, { passive: true });
    return () => page.removeEventListener("scroll", follow);
  }, [mode]);

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    const el = event.currentTarget;
    const c = shortcut(event, fieldOf(el));
    if (!c) return;
    event.preventDefault();
    event.stopPropagation();
    apply(el, c);
  };

  return (
    <div className={`doc-surface doc-surface-${mode}`}>
      {write
        ? (
          <div className="doc-grow" data-value={`${value}\n`}>
            <Textarea
              ref={field}
              bare
              className="doc-input"
              value={value}
              placeholder={placeholder}
              aria-label={label}
              spellCheck
              onChange={(event) => {
                onChange(event.target.value);
                inSight(event.target);
              }}
              onKeyDown={keyDown}
              onPaste={(event) => {
                const el = event.currentTarget;
                const c = pasted(fieldOf(el), event.clipboardData.getData("text/plain"));
                if (!c) return;
                event.preventDefault();
                apply(el, c);
              }}
            />
          </div>
        )
        : null}
      {read
        ? (
          <div
            ref={preview}
            className="doc-preview"
            aria-label={mode === "split" ? "Preview" : undefined}
            role={mode === "split" ? "region" : undefined}
          >
            {shown.trim()
              ? <Markdown text={shown} className="doc-md" />
              : <p className="doc-empty-preview">Nothing written yet.</p>}
          </div>
        )
        : null}
    </div>
  );
}

/** Whether the window is wide enough for Split, kept current. */
export function useWide(width = 980): boolean {
  const query = `(min-width: ${width}px)`;
  const [wide, setWide] = useState(() => globalThis.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const list = globalThis.matchMedia?.(query);
    if (!list) return;
    const changed = () => setWide(list.matches);
    list.addEventListener("change", changed);
    return () => list.removeEventListener("change", changed);
  }, [query]);
  return wide;
}
