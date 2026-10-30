/**
 * Something that opens beside its button and holds more than a menu's
 * items: an org switcher (orgs with their faces, invitations to answer in
 * place), a picker. The button is the front end's own (`trigger`, given the
 * props that open it); what's inside is anything, or a function of `close`.
 *
 * It's an auto popover (the top layer; a click outside or Escape closes it)
 * placed beside its button (`anchor`), labelled by `label`. Opening it, or
 * ArrowDown on the button, focuses the first item (an element marked
 * `data-popover-item`); arrows, Home and End move between items; closing it
 * gives focus back to the button.
 *
 * ```tsx
 * <Popover label="Switch org" trigger={(p) => <button {...p}>Acme</button>}>
 *   {(close) => <button data-popover-item onClick={close}>Personal</button>}
 * </Popover>
 * ```
 */
import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type ToggleEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { anchor, ANCHORED, type Placement } from "./anchor.tsx";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

/** What the trigger is given: spread them on a button. */
export type PopoverTrigger = {
  ref: Ref<HTMLButtonElement>;
  popoverTarget: string;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  "aria-controls": string;
  onKeyDown(event: KeyboardEvent<HTMLElement>): void;
};

const SHEET = sheet(
  "popover",
  `
.copilotz-popover { width: var(--copilotz-popover-width, 300px); max-width: calc(100vw - 16px);
  max-height: min(560px, calc(100dvh - 24px)); padding: 6px; overflow: auto; overscroll-behavior: contain;
  border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-lg); scrollbar-width: thin; }
.copilotz-popover:popover-open { animation: copilotz-popover .15s cubic-bezier(.2, .8, .2, 1); }
.copilotz-popover[data-side=top]:popover-open { animation-name: copilotz-popover-up; }
@keyframes copilotz-popover { from { opacity: 0; transform: translateY(-4px) scale(.985); } }
@keyframes copilotz-popover-up { from { opacity: 0; transform: translateY(4px) scale(.985); } }
`,
);

const itemsOf = (box: HTMLElement | null) => [
  ...box?.querySelectorAll<HTMLElement>(
    "[data-popover-item]:not(:disabled):not([aria-disabled=true])",
  ) ?? [],
];

export function Popover(
  { label, trigger, side = "bottom", align = "start", width, className, children }: {
    /** What it is, said to screen readers. */
    label: string;
    trigger(props: PopoverTrigger): ReactNode;
    side?: Placement["side"];
    align?: Placement["align"];
    /** Its width, in pixels (300 by default). */
    width?: number;
    className?: string;
    children: ReactNode | ((close: () => void) => ReactNode);
  },
): ReactNode {
  const id = `${useId()}-popover`;
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !box.current || !button.current) return;
    return anchor(box.current, button.current, { side, align, gap: 6 });
  }, [open]);

  const focus = (which: "first" | "last" | number) => {
    const all = itemsOf(box.current);
    const at = which === "first" ? 0 : which === "last" ? all.length - 1 : which;
    all[(at + all.length) % all.length]?.focus();
  };
  const close = () => box.current?.hidePopover();

  const toggled = (event: ToggleEvent<HTMLDivElement>) => {
    const opened = event.newState === "open";
    setOpen(opened);
    if (opened) requestAnimationFrame(() => focus("first"));
    else if (
      !document.activeElement || document.activeElement === document.body ||
      box.current?.contains(document.activeElement)
    ) button.current?.focus();
  };

  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const all = itemsOf(box.current);
    const at = all.indexOf(document.activeElement as HTMLElement);
    // Arrows move between items, unless a field inside keeps them.
    if ((event.target as HTMLElement).matches("input, textarea, select")) return;
    const move: Record<string, () => void> = {
      ArrowDown: () => focus(at + 1),
      ArrowUp: () => focus(at < 0 ? "last" : at - 1),
      Home: () => focus("first"),
      End: () => focus("last"),
    };
    if (!move[event.key]) return;
    event.preventDefault();
    move[event.key]();
  };

  return (
    <>
      {SHEET}
      {ANCHORED}
      {trigger({
        ref: button,
        popoverTarget: id,
        "aria-haspopup": "dialog",
        "aria-expanded": open,
        "aria-controls": id,
        onKeyDown: (event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          box.current?.showPopover();
          requestAnimationFrame(() => focus(event.key === "ArrowUp" ? "last" : "first"));
        },
      })}
      <div
        ref={box}
        id={id}
        popover="auto"
        role="dialog"
        aria-label={label}
        className={cx("copilotz-popover copilotz-anchored", className)}
        style={width
          ? { "--copilotz-popover-width": `${width}px` } as Record<string, string>
          : undefined}
        onToggle={toggled}
        onKeyDown={keys}
      >
        {typeof children === "function" ? children(close) : children}
      </div>
    </>
  );
}
