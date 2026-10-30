/// <reference lib="dom" />
/**
 * Choices that pop over a field as someone types (an `@name` in a message):
 * a listbox in the top layer, placed by script beside what it's for
 * (`anchor`: above `target` by default, below it when there's no room). It
 * never takes focus: the field keeps it and drives the list with its keys
 * (↑ ↓ move `active`, Enter or Tab choose, Escape closes), naming the active
 * option by `aria-activedescendant` (`optionId`). A click chooses too, and
 * the pointer moves `active` as it goes. With nothing to offer, it says
 * `empty`, or hides. A `title` heads it ("Agents in Launch").
 *
 * ```tsx
 * <Autocomplete id={list} target={box} open={!!typing} label="Agents here" options={found}
 *   active={active} onActive={setActive} onPick={(option) => insert(option.key)} />
 * <textarea aria-controls={list} aria-activedescendant={optionId(list, active)} … />
 * ```
 */
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { anchor, ANCHORED } from "./anchor.tsx";
import { sheet } from "./sheet.tsx";

/** One choice: a `key` the field uses, what it shows, and maybe an avatar before it. */
export type AutocompleteOption = {
  key: string;
  label: ReactNode;
  /** A quieter line after it: what it is. */
  description?: ReactNode;
  /** Before it: an avatar, an icon. */
  leading?: ReactNode;
  /** At its end: a badge. */
  end?: ReactNode;
};

/** The id of the list's option at `index`, for the field's `aria-activedescendant`. */
export const optionId = (list: string, index: number) => `${list}-option-${index}`;

const SHEET = sheet(
  "autocomplete",
  `
.copilotz-autocomplete { width: min(380px, calc(100vw - 16px)); max-height: min(320px, calc(100vh - 32px));
  overflow-y: auto; overscroll-behavior: contain; padding: 5px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--popover); color: var(--popover-foreground);
  box-shadow: var(--shadow-lg); scrollbar-width: thin; }
.copilotz-autocomplete:popover-open { animation: copilotz-autocomplete .12s ease-out; }
@keyframes copilotz-autocomplete { from { opacity: 0; transform: translateY(3px); } }
.copilotz-autocomplete[data-side=bottom]:popover-open { animation-name: copilotz-autocomplete-down; }
@keyframes copilotz-autocomplete-down { from { opacity: 0; transform: translateY(-3px); } }
.copilotz-autocomplete-title { margin: 0; padding: 6px 9px 5px; color: var(--muted-foreground); font-size: 11.5px;
  font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.copilotz-autocomplete-option { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 5px 9px;
  border-radius: var(--radius-md); cursor: pointer; user-select: none; }
.copilotz-autocomplete-option[aria-selected=true] { background: var(--accent); color: var(--accent-foreground); }
.copilotz-autocomplete-text { flex: 1; display: grid; min-width: 0; line-height: 1.3; }
.copilotz-autocomplete-label { overflow: hidden; font-size: 14px; font-weight: 560; text-overflow: ellipsis;
  white-space: nowrap; }
.copilotz-autocomplete-description { overflow: hidden; color: var(--muted-foreground); font-size: 12.5px;
  text-overflow: ellipsis; white-space: nowrap; }
.copilotz-autocomplete-end { flex: none; display: flex; align-items: center; }
.copilotz-autocomplete-empty { margin: 0; padding: 10px 9px; color: var(--muted-foreground); font-size: 13px; }
@media (pointer: coarse) { .copilotz-autocomplete-option { min-height: 46px; } }
`,
);

export function Autocomplete(
  {
    id,
    target,
    open,
    label,
    title,
    options,
    active,
    onActive,
    onPick,
    empty,
    side = "top",
  }: {
    /** The list's id: the field's `aria-controls`. */
    id: string;
    /** What it's placed beside: the field, or the box around it. */
    target: RefObject<HTMLElement | null>;
    open: boolean;
    /** What the list is, said to screen readers. */
    label: string;
    title?: ReactNode;
    options: AutocompleteOption[];
    /** The option the field's keys are on. */
    active: number;
    onActive(index: number): void;
    onPick(option: AutocompleteOption, index: number): void;
    /** What it says when nothing matches; without it, it hides. */
    empty?: ReactNode;
    side?: "top" | "bottom";
  },
): ReactNode {
  const list = useRef<HTMLDivElement>(null);
  const shown = open && (options.length > 0 || !!empty);

  // Shown in the top layer beside its field, and placed again as what it lists changes size.
  useEffect(() => {
    const el = list.current;
    const at = target.current;
    if (!shown || !el || !at) return;
    if (!el.matches(":popover-open")) el.showPopover();
    const stop = anchor(el, at, { side, align: "start", gap: 8 });
    return () => {
      stop();
      if (el.matches(":popover-open")) el.hidePopover();
    };
  }, [shown, options.length, side]);
  // The active option in view.
  useEffect(() => {
    if (shown) document.getElementById(optionId(id, active))?.scrollIntoView({ block: "nearest" });
  }, [shown, active]);

  return (
    <>
      {SHEET}
      {ANCHORED}
      <div
        ref={list}
        id={id}
        popover="manual"
        role="listbox"
        aria-label={label}
        className="copilotz-autocomplete copilotz-anchored"
      >
        {title ? <p className="copilotz-autocomplete-title" aria-hidden="true">{title}</p> : null}
        {options.map((option, i) => (
          <div
            key={option.key}
            id={optionId(id, i)}
            role="option"
            aria-selected={i === active}
            className="copilotz-autocomplete-option"
            // The field keeps focus: a press here doesn't take it.
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => i !== active && onActive(i)}
            onClick={() => onPick(option, i)}
          >
            {option.leading}
            <span className="copilotz-autocomplete-text">
              <span className="copilotz-autocomplete-label">{option.label}</span>
              {option.description
                ? <span className="copilotz-autocomplete-description">{option.description}</span>
                : null}
            </span>
            {option.end ? <span className="copilotz-autocomplete-end">{option.end}</span> : null}
          </div>
        ))}
        {!options.length && empty ? <p className="copilotz-autocomplete-empty">{empty}</p> : null}
      </div>
    </>
  );
}
