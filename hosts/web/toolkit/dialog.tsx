/**
 * A dialog over the page: the browser's own modal `<dialog>` (everything
 * behind it inert, focus kept in it and given back to what opened it).
 * Escape, the backdrop or its close button end it (`onClose`). A `title`
 * (and `description`) over what's in it, a `footer` of actions; `sm`, `md`,
 * `lg`, or `auto` (as wide as what's in it). `bare` leaves the layout to
 * what's in it (a picture), named by `label`.
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

const SHEET = sheet(
  "dialog",
  `
.copilotz-dialog { width: min(520px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 48px);
  padding: 0; border: 1px solid var(--border); border-radius: var(--radius-2xl); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-lg); overflow: hidden; }
.copilotz-dialog-sm { width: min(400px, calc(100vw - 32px)); }
.copilotz-dialog-lg { width: min(760px, calc(100vw - 32px)); }
.copilotz-dialog-auto { width: auto; max-width: min(1100px, calc(100vw - 32px)); }
.copilotz-dialog[open] { display: flex; animation: copilotz-dialog .18s cubic-bezier(.2, .8, .2, 1); }
.copilotz-dialog::backdrop { background: rgb(8 8 14 / .55); }
.copilotz-dialog[open]::backdrop { animation: copilotz-backdrop .18s ease-out; }
@keyframes copilotz-dialog { from { opacity: 0; transform: translateY(6px) scale(.98); } }
@keyframes copilotz-backdrop { from { opacity: 0; } }
.copilotz-dialog-box { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.copilotz-dialog-head { display: flex; align-items: flex-start; gap: 12px; padding: 18px 14px 2px 22px; }
.copilotz-dialog-head > div { flex: 1; min-width: 0; }
.copilotz-dialog-title { margin: 4px 0 0; font-family: var(--font-display); font-size: 17px; font-weight: 650;
  line-height: 1.3; letter-spacing: -.01em; }
.copilotz-dialog-description { margin: 4px 0 0; color: var(--muted-foreground); font-size: 14px; }
.copilotz-dialog-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 22px 22px; }
.copilotz-dialog-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; padding: 14px 18px;
  border-top: 1px solid var(--border); background: color-mix(in oklab, var(--muted) 45%, var(--popover)); }
`,
);

export function Dialog(
  { open, onClose, title, description, label, size = "md", bare, footer, className, children }: {
    open: boolean;
    onClose(): void;
    title?: ReactNode;
    description?: ReactNode;
    /** What it is, said to screen readers, when it has no title. */
    label?: string;
    size?: "sm" | "md" | "lg" | "auto";
    bare?: boolean;
    footer?: ReactNode;
    /** The box inside it. */
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const { ref, events } = useModal(open, onClose);
  const id = useId();
  return (
    <dialog
      ref={ref}
      className={cx("copilotz-dialog", size !== "md" && `copilotz-dialog-${size}`)}
      aria-labelledby={title ? `${id}-title` : undefined}
      aria-label={title ? undefined : label}
      aria-describedby={description ? `${id}-description` : undefined}
      closedby="any"
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
                label="Close"
                size="sm"
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
