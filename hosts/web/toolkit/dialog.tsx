/**
 * A dialog over the page: the browser's own modal `<dialog>` (everything
 * behind it inert, focus kept in it and given back to what opened it).
 * Escape, the backdrop or its close button end it (`onClose`). A `title`
 * (and `description`) over what's in it, a `footer` of actions; `sm`, `md`,
 * `lg`, or `auto` (as wide as what's in it). `bare` leaves the layout to
 * what's in it (a picture), named by `label`. Centred, or near the top
 * (`placement="top"`: a form that grows downwards stays put). Opened, focus
 * goes to its first field, or stays on the dialog itself (`focus="dialog"`:
 * nothing is typed into until someone chooses to). While `busy` (a save it
 * started is under way), Escape, the backdrop and its close button wait, and
 * it says so (`aria-busy`). `role="alertdialog"` for one that interrupts to
 * ask (`ConfirmDialog`), and `aria-describedby` for what describes it when
 * that isn't its `description`. `isolated`: its close and Escape are its
 * own: a dialog shown inside it (a confirmation over a form) closing doesn't
 * close it, and its own closing doesn't reach a dialog it's shown inside.
 *
 * Its look is the theme's: `dialog-width` (and `-sm`, `-lg`), `dialog-radius`,
 * `dialog-head-*` (background, foreground, padding, border), `dialog-title-*`,
 * `dialog-body-padding`, `dialog-foot-*`, `dialog-backdrop`, `dialog-top`.
 *
 * ```tsx
 * <Dialog open={open} onClose={() => setOpen(false)} title="Rename" footer={<Button …>Save</Button>}>
 *   <Field label="Name">{(c) => <Input {...c} />}</Field>
 * </Dialog>
 * ```
 */
import { type ReactNode, useId } from "react";
import { cx } from "./cx.ts";
import { IconButton } from "./icon-button.tsx";
import { useModal } from "./modal.ts";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

const SHEET = sheet(
  "dialog",
  `
.copilotz-dialog { width: min(var(--dialog-width, 520px), calc(100vw - 32px)); max-width: none;
  max-height: calc(100dvh - 48px); padding: 0; border: 1px solid var(--dialog-border-color, var(--border));
  border-radius: var(--dialog-radius, var(--radius-2xl)); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--dialog-shadow, var(--shadow-lg)); overflow: hidden; }
.copilotz-dialog:focus-visible { outline: none; }
.copilotz-dialog-sm { width: min(var(--dialog-width-sm, 400px), calc(100vw - 32px)); }
.copilotz-dialog-lg { width: min(var(--dialog-width-lg, 760px), calc(100vw - 32px)); }
.copilotz-dialog-auto { width: auto; max-width: min(1100px, calc(100vw - 32px)); }
.copilotz-dialog-top { margin-block: var(--dialog-top, min(12vh, 96px)) auto;
  max-height: calc(100dvh - var(--dialog-top, min(12vh, 96px)) - 24px); }
.copilotz-dialog[open] { display: flex; animation: copilotz-dialog .18s cubic-bezier(.2, .8, .2, 1); }
.copilotz-dialog::backdrop { background: var(--dialog-backdrop, rgb(8 8 14 / .55)); }
.copilotz-dialog[open]::backdrop { animation: copilotz-backdrop .18s ease-out; }
@keyframes copilotz-dialog { from { opacity: 0; transform: translateY(6px) scale(.98); } }
@keyframes copilotz-backdrop { from { opacity: 0; } }
.copilotz-dialog-box { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.copilotz-dialog-head { display: flex; align-items: flex-start; gap: 12px;
  padding: var(--dialog-head-padding, 18px 14px 2px 22px); border-bottom: var(--dialog-head-border, 0);
  background: var(--dialog-head-background, transparent); color: var(--dialog-head-foreground, inherit); }
.copilotz-dialog-head > div { flex: 1; min-width: 0; }
.copilotz-dialog-head .copilotz-icon-button { color: var(--dialog-close-color, var(--muted-foreground)); }
.copilotz-dialog-title { margin: var(--dialog-title-margin, 4px 0 0);
  font-family: var(--dialog-title-font-family, var(--font-display));
  font-size: var(--dialog-title-font-size, 17px); font-weight: var(--dialog-title-font-weight, 650);
  line-height: 1.3; letter-spacing: var(--dialog-title-letter-spacing, -.01em); }
.copilotz-dialog-description { margin: 4px 0 0; color: var(--muted-foreground); font-size: 14px; }
.copilotz-dialog-body { flex: 1 1 auto; min-height: 0; overflow: auto;
  padding: var(--dialog-body-padding, 14px 22px 22px); }
.copilotz-dialog-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--dialog-foot-gap, 8px);
  padding: var(--dialog-foot-padding, 14px 18px); border-top: var(--dialog-foot-border, 1px solid var(--border));
  background: var(--dialog-foot-background, color-mix(in oklab, var(--muted) 45%, var(--popover))); }
`,
);

export function Dialog(
  {
    open,
    onClose,
    title,
    description,
    label,
    size = "md",
    placement = "center",
    focus = "first",
    bare,
    busy = false,
    isolated = false,
    role,
    footer,
    className,
    children,
    "aria-describedby": describedBy,
  }: {
    open: boolean;
    onClose(): void;
    title?: ReactNode;
    description?: ReactNode;
    /** What it is, said to screen readers, when it has no title. */
    label?: string;
    size?: "sm" | "md" | "lg" | "auto";
    /** In the middle of the screen, or near its top. */
    placement?: "center" | "top";
    /** What has focus once it opens: its first field, or the dialog itself. */
    focus?: "first" | "dialog";
    bare?: boolean;
    /**
     * Something it started is under way (a save): Escape, a press on the backdrop and its close
     * button wait (the button is disabled), and it says so (`aria-busy`). Closing it from its
     * `open` still closes it.
     */
    busy?: boolean;
    /**
     * Its close and Escape are its own: a dialog shown inside it (a confirmation over a form)
     * closing doesn't close it, and its own closing doesn't reach a dialog it's shown inside (React
     * passes those events up through the components).
     */
    isolated?: boolean;
    /** `alertdialog` for one that interrupts to ask before going on (see `ConfirmDialog`). */
    role?: "dialog" | "alertdialog";
    /** The id of what describes it, when that isn't its `description`. */
    "aria-describedby"?: string;
    footer?: ReactNode;
    /** The box inside it. */
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const { ref, events } = useModal(open, onClose, { focus, keep: busy, isolated });
  const id = useId();
  return (
    <dialog
      ref={ref}
      className={cx(
        "copilotz-dialog",
        size !== "md" && `copilotz-dialog-${size}`,
        placement === "top" && "copilotz-dialog-top",
      )}
      tabIndex={focus === "dialog" ? -1 : undefined}
      role={role === "alertdialog" ? role : undefined}
      aria-labelledby={title ? `${id}-title` : undefined}
      aria-label={title ? undefined : label}
      aria-describedby={describedBy ?? (description ? `${id}-description` : undefined)}
      aria-busy={busy || undefined}
      closedby={busy ? "none" : "any"}
      {...events}
    >
      {SHEET}
      <div className={cx("copilotz-dialog-box", className)}>
        {title
          ? (
            <header className="copilotz-dialog-head">
              <div>
                <h2 id={`${id}-title`} className="copilotz-dialog-title">{title}</h2>
                {description
                  ? (
                    <p id={`${id}-description`} className="copilotz-dialog-description">
                      {description}
                    </p>
                  )
                  : null}
              </div>
              <IconButton
                icon="close"
                label={say("close")}
                size="sm"
                disabled={busy || undefined}
                onClick={() => ref.current?.close()}
              />
            </header>
          )
          : null}
        {bare ? children : <div className="copilotz-dialog-body">{children}</div>}
        {footer ? <footer className="copilotz-dialog-foot">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
