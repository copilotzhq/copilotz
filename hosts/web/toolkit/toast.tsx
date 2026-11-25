/**
 * Toasts: a short message over the page for a few seconds, "Saved" after a
 * save, "Deleted 3 items" after a delete. `toast(message, tone)` from
 * anywhere (a handler, a plain function); `<Toasts />` where they show,
 * once per page (the Copilotz shell has one; an app without the shell puts
 * it in its own frame). Tones: `neutral`, `success`, `info`, `warning` and
 * `destructive`, which is said at once (an alert); the others are said
 * politely, when the screen reader is free.
 *
 * Each stays five seconds (`duration`, in milliseconds; `0`: until it's
 * dismissed), and waits while the pointer is on it or the keyboard is in
 * it. Its × dismisses it, and `toast()` gives back what dismisses it early.
 * Where two `<Toasts />` are mounted (the shell's and an app's), one shows
 * them: the one that chose its `placement`. That one also shows the dialogs
 * `confirm()` asks, one at a time.
 *
 * ```tsx
 * toast("Customer saved", "success");
 * toast("Couldn't reach the printer", { tone: "destructive", duration: 0 });
 * <Toasts placement="bottom" />
 * ```
 */
import { type ReactNode, useEffect, useId, useSyncExternalStore } from "react";
import { ConfirmQuestions } from "./confirm-dialog.tsx";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";
import {
  dismissToast,
  mountToasts,
  NO_TOASTS,
  pauseToast,
  placeToasts,
  resumeToast,
  subscribe,
  toastState,
  type ToastTone,
} from "./toast-state.ts";
import { say } from "./words.ts";

export { dismissToast, toast, type ToastOptions, type ToastTone } from "./toast-state.ts";

/** Where toasts show: a top or bottom edge, at its start, centre or end. */
export type ToastPlacement =
  | "top-start"
  | "top"
  | "top-end"
  | "bottom-start"
  | "bottom"
  | "bottom-end";

/** Each tone's colours by default: its soft surface, its text and border, its colour for the icon. */
const TONES: Record<
  ToastTone,
  { background: string; foreground: string; border: string; icon: string }
> = {
  neutral: {
    background: "var(--popover)",
    foreground: "var(--popover-foreground)",
    border: "var(--border)",
    icon: "var(--muted-foreground)",
  },
  success: {
    background: "var(--success-soft)",
    foreground: "var(--success-text)",
    border: "var(--success-border)",
    icon: "var(--success)",
  },
  info: {
    background: "var(--info-soft)",
    foreground: "var(--info-text)",
    border: "var(--info-border)",
    icon: "var(--info)",
  },
  warning: {
    background: "var(--warning-soft)",
    foreground: "var(--warning-text)",
    border: "var(--warning-border)",
    icon: "var(--warning)",
  },
  destructive: {
    background: "var(--destructive-soft)",
    foreground: "var(--destructive-text)",
    border: "var(--destructive-border)",
    icon: "var(--destructive)",
  },
};

const ICONS: Partial<Record<ToastTone, IconName>> = {
  success: "check-circle",
  info: "info",
  warning: "alert",
  destructive: "alert",
};

const SHEET = sheet(
  "toast",
  `
.copilotz-toasts { position: fixed; z-index: 1000; display: flex; flex-direction: column;
  gap: var(--toast-gap, 8px); width: min(var(--toast-width, 360px), calc(100vw - 2 * var(--toast-offset, 16px)));
  pointer-events: none; }
.copilotz-toasts[data-placement^=top] { top: max(var(--toast-offset, 16px), env(safe-area-inset-top));
  flex-direction: column-reverse; }
.copilotz-toasts[data-placement^=bottom] { bottom: max(var(--toast-offset, 16px), env(safe-area-inset-bottom)); }
.copilotz-toasts[data-placement$=start] { left: max(var(--toast-offset, 16px), env(safe-area-inset-left)); }
.copilotz-toasts[data-placement$=end] { right: max(var(--toast-offset, 16px), env(safe-area-inset-right)); }
.copilotz-toasts[data-placement=top], .copilotz-toasts[data-placement=bottom] { left: 50%; transform: translateX(-50%); }
.copilotz-toast { display: flex; align-items: flex-start; gap: var(--toast-icon-gap, 10px);
  padding: var(--toast-padding, 12px 12px 12px 14px); border: var(--toast-border-width, 1px) solid transparent;
  border-radius: var(--toast-radius, var(--radius-lg)); box-shadow: var(--toast-shadow, var(--shadow-md));
  font-size: var(--toast-font-size, 14px); font-weight: var(--toast-font-weight, 520);
  line-height: var(--toast-line-height, 1.45); pointer-events: auto; animation: copilotz-toast .18s ease-out; }
.copilotz-toasts[data-placement^=top] .copilotz-toast { animation-name: copilotz-toast-down; }
@keyframes copilotz-toast { from { opacity: 0; transform: translateY(6px); } }
@keyframes copilotz-toast-down { from { opacity: 0; transform: translateY(-6px); } }
.copilotz-toast > .copilotz-icon { display: var(--toast-icon-display, inline-block); margin-top: 1px; }
.copilotz-toast-message { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.copilotz-toast-close { flex: none; display: grid; place-items: center; width: 24px; height: 24px; margin: -2px -4px -2px 0;
  padding: 0; border: 0; border-radius: var(--radius-sm); background: transparent; color: inherit;
  opacity: var(--toast-close-opacity, .7); cursor: pointer; }
.copilotz-toast-close:hover { opacity: 1; }
@media (pointer: coarse) { .copilotz-toast-close { width: 36px; height: 36px; margin: -8px -8px -8px 0; } }
${
    Object.entries(TONES).map(([tone, c]) =>
      `.copilotz-toast-${tone} { background: var(--toast-${tone}-background, ${c.background});
  color: var(--toast-${tone}-foreground, ${c.foreground}); border-color: var(--toast-${tone}-border, ${c.border}); }
.copilotz-toast-${tone} > .copilotz-icon { color: var(--toast-${tone}-icon, ${c.icon}); }`
    ).join("\n")
  }
`,
);

/** Where toasts show, once per page, and the dialogs `confirm()` asks. */
export function Toasts({ placement }: {
  /** Which edge and where on it (the end of the bottom one by default). */
  placement?: ToastPlacement;
}): ReactNode {
  const id = useId();
  const placed = placement !== undefined;
  const { toasts, shownBy } = useSyncExternalStore(subscribe, toastState, () => NO_TOASTS);
  useEffect(() => mountToasts(id, placed), [id]);
  useEffect(() => placeToasts(id, placed), [id, placed]);
  if (shownBy !== id) return null;
  return (
    <>
      <div
        className="copilotz-toasts"
        data-placement={placement ?? "bottom-end"}
        role="status"
        aria-live="polite"
        aria-label={say("notifications")}
      >
        {SHEET}
        {toasts.map((t) => {
          const icon = ICONS[t.tone];
          return (
            <div
              key={t.id}
              className={cx("copilotz-toast", `copilotz-toast-${t.tone}`)}
              role={t.tone === "destructive" ? "alert" : undefined}
              onMouseEnter={() => pauseToast(t.id)}
              onMouseLeave={(event) => {
                if (!event.currentTarget.contains(document.activeElement)) resumeToast(t.id);
              }}
              onFocus={() => pauseToast(t.id)}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  resumeToast(t.id);
                }
              }}
            >
              {icon ? <Icon name={icon} size={18} /> : null}
              <div className="copilotz-toast-message">{t.message}</div>
              <button
                type="button"
                className="copilotz-toast-close"
                aria-label={say("close")}
                onClick={() => dismissToast(t.id)}
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          );
        })}
      </div>
      <ConfirmQuestions />
    </>
  );
}
