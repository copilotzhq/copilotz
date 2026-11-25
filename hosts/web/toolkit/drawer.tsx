/**
 * A panel that slides in from a side (`left`, the default; `right`;
 * `bottom`, a sheet): the browser's own modal `<dialog>`, as `Dialog` is.
 * Escape, the backdrop or `onClose` end it. A `title` over what's in it, or
 * just a `label` for screen readers; `className` is its box's, which
 * fills it. On a phone it keeps clear of what covers the screen's edges (the
 * status bar, a notch, the home indicator: the safe-area insets) on the sides
 * it runs along; a sheet's foot keeps clear of the home indicator on its own.
 * `isolated`: its close and Escape are its own, as a `Dialog`'s are with it.
 *
 * ```tsx
 * <Drawer open={open} onClose={() => setOpen(false)} label="Sidebar">{sidebar}</Drawer>
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { IconButton } from "./icon-button.tsx";
import { useModal } from "./modal.ts";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

const SHEET = sheet(
  "drawer",
  `
.copilotz-drawer { position: fixed; inset: 0 auto 0 0; width: min(86vw, var(--drawer-width, 320px)); max-width: none; height: 100dvh;
  max-height: none; margin: 0; padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom) env(safe-area-inset-left);
  border: 0; background: var(--popover); color: var(--popover-foreground);
  box-shadow: var(--shadow-lg); transform: translateX(-102%);
  transition: transform .28s cubic-bezier(.2, .8, .2, 1), overlay .28s allow-discrete, display .28s allow-discrete; }
.copilotz-drawer-right { inset: 0 0 0 auto; transform: translateX(102%);
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) 0; }
.copilotz-drawer-bottom { inset: auto 0 0 0; width: 100%; height: auto; max-height: 85dvh;
  padding: 0 env(safe-area-inset-right) 0 env(safe-area-inset-left);
  border-radius: var(--radius-2xl) var(--radius-2xl) 0 0; transform: translateY(102%); }
.copilotz-drawer[open] { display: flex; transform: none; }
@starting-style {
  .copilotz-drawer[open] { transform: translateX(-102%); }
  .copilotz-drawer-right[open] { transform: translateX(102%); }
  .copilotz-drawer-bottom[open] { transform: translateY(102%); }
}
.copilotz-drawer::backdrop { background: rgb(8 8 14 / 0);
  transition: background-color .28s, overlay .28s allow-discrete, display .28s allow-discrete; }
.copilotz-drawer[open]::backdrop { background: rgb(8 8 14 / .42); }
@starting-style { .copilotz-drawer[open]::backdrop { background: rgb(8 8 14 / 0); } }
.copilotz-drawer-box { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; overflow: auto; }
.copilotz-drawer-head { display: flex; align-items: center; gap: 8px; padding: 14px 12px 8px 20px; }
.copilotz-drawer-title { flex: 1; min-width: 0; margin: 0; font-family: var(--font-display); font-size: 16px;
  font-weight: 650; }
`,
);

export function Drawer(
  { open, onClose, side = "left", title, label, isolated = false, className, children }: {
    open: boolean;
    onClose(): void;
    side?: "left" | "right" | "bottom";
    /**
     * Its close and Escape are its own: a dialog shown inside it closing doesn't close it, and its
     * own closing doesn't reach a dialog it's shown inside (React passes those events up).
     */
    isolated?: boolean;
    title?: ReactNode;
    label?: string;
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const { ref, events } = useModal(open, onClose, { isolated });
  return (
    <dialog
      ref={ref}
      className={cx("copilotz-drawer", side !== "left" && `copilotz-drawer-${side}`)}
      aria-label={typeof title === "string" ? title : label}
      closedby="any"
      {...events}
    >
      {SHEET}
      <div className={cx("copilotz-drawer-box", className)}>
        {title
          ? (
            <header className="copilotz-drawer-head">
              <h2 className="copilotz-drawer-title">{title}</h2>
              <IconButton icon="close" label={say("close")} onClick={() => ref.current?.close()} />
            </header>
          )
          : null}
        {children}
      </div>
    </dialog>
  );
}
