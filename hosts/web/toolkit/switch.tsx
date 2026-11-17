/**
 * An on/off switch (`role="switch"`): a setting that takes effect as it's
 * flipped. A track with a thumb that slides to its end when on; given
 * words (`on`, `off`), it shows the current one beside the thumb, as an
 * on/off toggle with labels does ("%" or "$"). `sm`, `md` or `lg`. Name it
 * with `label` when nothing on the page labels it.
 *
 * Joined to a field (`joined="end"`, in an `Input`'s `addonEnd`), it takes
 * the field's height and squares its corners on that side.
 *
 * ```tsx
 * <Switch label="Notify me" checked={notify} onChange={setNotify} />
 * <Switch label="Discount type" checked={fixed} onChange={setFixed} on="$" off="%" />
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "switch",
  `
.copilotz-switch { position: relative; display: inline-flex; flex: none; flex-direction: row-reverse; align-items: stretch;
  box-sizing: border-box; min-width: var(--switch-width, 36px); height: var(--switch-height, 20px);
  padding: var(--switch-padding, 2px); border: var(--switch-border-width, 0) solid var(--switch-border-color, transparent);
  border-radius: var(--switch-radius, 9999px); background: var(--switch-off-background, var(--input));
  color: var(--switch-off-foreground, var(--secondary-foreground));
  font: inherit; font-size: var(--switch-font-size, 12px); font-weight: var(--switch-font-weight, 650);
  line-height: 1; cursor: pointer; vertical-align: middle; transition: background-color .15s; }
.copilotz-switch-sm { min-width: var(--switch-width-sm, 30px); height: var(--switch-height-sm, 16px); }
.copilotz-switch-lg { min-width: var(--switch-width-lg, 44px); height: var(--switch-height-lg, 24px); }
.copilotz-switch[aria-checked=true] { flex-direction: row; background: var(--switch-on-background, var(--primary));
  color: var(--switch-on-foreground, var(--primary-foreground)); }
.copilotz-switch-thumb { flex: none; aspect-ratio: var(--switch-thumb-aspect, 1); height: 100%;
  width: var(--switch-thumb-width, auto); border-radius: var(--switch-thumb-radius, 9999px);
  background: var(--switch-thumb-background, var(--background)); box-shadow: var(--switch-thumb-shadow, var(--shadow-sm)); }
.copilotz-switch-word { flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 0 var(--switch-word-padding, 7px); white-space: nowrap; }
.copilotz-switch:not(:has(.copilotz-switch-word))::before { content: ""; flex: 1; }
.copilotz-switch:disabled { opacity: var(--switch-disabled-opacity, .5); cursor: default; }
.copilotz-switch:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.copilotz-switch[data-joined] { height: auto; align-self: stretch; }
.copilotz-switch[data-joined=end] { border-top-left-radius: 0; border-bottom-left-radius: 0; }
.copilotz-switch[data-joined=start] { border-top-right-radius: 0; border-bottom-right-radius: 0; }
/* Touch screens: a target a finger finds, the switch as drawn */
@media (pointer: coarse) {
  .copilotz-switch:not([data-joined])::after { content: ""; position: absolute; inset: -10px -4px; }
}
`,
);

export function Switch(
  { checked, onChange, on, off, label, size = "md", joined, className, ...rest }:
    & {
      checked: boolean;
      onChange(checked: boolean): void;
      /** What it says while on (the words are shown beside the thumb). */
      on?: ReactNode;
      /** What it says while off. */
      off?: ReactNode;
      /** What it is, said to screen readers, when nothing on the page labels it. */
      label?: string;
      size?: "sm" | "md" | "lg";
      /** Joined to a field at its end (or start): the field's height, square on that side. */
      joined?: "start" | "end";
      className?: string;
    }
    & Omit<ComponentProps<"button">, "onChange" | "role" | "aria-checked" | "type" | "children">,
): ReactNode {
  const word = checked ? on : off;
  return (
    <>
      {SHEET}
      <button
        type="button"
        {...rest}
        role="switch"
        aria-checked={checked}
        aria-label={label ?? rest["aria-label"]}
        data-joined={joined}
        className={cx("copilotz-switch", size !== "md" && `copilotz-switch-${size}`, className)}
        onClick={(event) => {
          rest.onClick?.(event);
          if (!event.defaultPrevented) onChange(!checked);
        }}
      >
        {on !== undefined || off !== undefined
          ? <span className="copilotz-switch-word">{word}</span>
          : null}
        <span className="copilotz-switch-thumb" aria-hidden="true" />
      </button>
    </>
  );
}
