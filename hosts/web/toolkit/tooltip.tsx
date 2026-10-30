/**
 * A short line about the one element it wraps: shown after a moment under
 * the pointer, at once when Tab brings focus to it (not when a dialog or a
 * menu hands focus back), hidden by leaving, a press or Escape. It's a manual popover (the top layer, over anything),
 * placed above (or below) by `anchor`. It describes its element, unless
 * `describe` is false (an icon button already named by the same words);
 * `disabled`, it stays hidden (its element stays as it is).
 *
 * ```tsx
 * <Tooltip text="Was: Ana lives in Porto"><span>updated</span></Tooltip>
 * ```
 */
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { anchor, ANCHORED } from "./anchor.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "tooltip",
  `
.copilotz-tooltip-for { display: contents; }
.copilotz-tooltip { max-width: min(280px, calc(100vw - 16px)); padding: 5px 9px; border: 0;
  border-radius: var(--radius-sm); background: var(--foreground); color: var(--background);
  font-size: 12.5px; font-weight: 520; line-height: 1.35; box-shadow: var(--shadow-md);
  pointer-events: none; overflow-wrap: anywhere; animation: copilotz-tooltip .12s ease-out; }
@keyframes copilotz-tooltip { from { opacity: 0; } }
`,
);

/** How long the pointer rests before it shows. */
const DELAY = 450;

/** When Tab was last pressed: focus that follows it is the keyboard's own. */
let tabbed = 0;
globalThis.addEventListener?.("keydown", (event) => {
  if ((event as KeyboardEvent).key === "Tab") tabbed = Date.now();
}, true);

export function Tooltip(
  { text, side = "top", describe = true, disabled, children }: {
    text: ReactNode;
    side?: "top" | "bottom";
    describe?: boolean;
    disabled?: boolean;
    children: ReactNode;
  },
): ReactNode {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const id = useId();
  const later = (ms: number) => {
    clearTimeout(timer.current);
    if (!disabled) timer.current = setTimeout(() => setOpen(true), ms);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = open && !disabled;
  useLayoutEffect(() => {
    const popover = tip.current;
    const target = wrap.current?.firstElementChild as HTMLElement | null;
    if (!shown || !popover || !target) return;
    popover.showPopover?.();
    const release = anchor(popover, target, { side, align: "center", gap: 8 });
    if (describe) target.setAttribute("aria-describedby", id);
    const escape = (event: KeyboardEvent) => event.key === "Escape" && hide();
    addEventListener("keydown", escape);
    return () => {
      release();
      removeEventListener("keydown", escape);
      if (describe) target.removeAttribute("aria-describedby");
    };
  }, [shown]);

  return (
    <span
      ref={wrap}
      className="copilotz-tooltip-for"
      onPointerEnter={(event) => event.pointerType === "mouse" && later(DELAY)}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={() => Date.now() - tabbed < 500 && later(0)}
      onBlur={hide}
    >
      {SHEET}
      {ANCHORED}
      {children}
      {shown
        ? (
          <span
            ref={tip}
            id={id}
            popover="manual"
            role="tooltip"
            className="copilotz-tooltip copilotz-anchored"
          >
            {text}
          </span>
        )
        : null}
    </span>
  );
}
