/**
 * Text over several lines. `autoGrow` makes it as tall as what's written (up
 * to `maxHeight`); `bare` leaves out its box, for a front end that frames it
 * itself (chat's composer). `invalid` (or `aria-invalid`) marks it.
 */
import { type ComponentProps, type ReactNode, useLayoutEffect, useRef } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "textarea",
  `
.copilotz-textarea { display: block; width: 100%; min-height: 84px; margin: 0; padding: 10px 12px;
  border: 1px solid var(--input); border-radius: var(--radius-lg); background: var(--card);
  color: var(--foreground); font-size: 14.5px; line-height: 1.5; resize: vertical;
  transition: border-color .15s, box-shadow .15s; }
.copilotz-textarea:focus-visible { outline: none; border-color: var(--ring);
  box-shadow: 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent); }
.copilotz-textarea[aria-invalid=true] { border-color: var(--destructive); }
.copilotz-textarea::placeholder { color: var(--muted-foreground); opacity: .85; }
.copilotz-textarea-grow { resize: none; overflow-y: auto; }
.copilotz-textarea-bare, .copilotz-textarea-bare:focus-visible { min-height: 0; padding: 0; border: 0; border-radius: 0;
  background: transparent; box-shadow: none; outline: none; resize: none; }
`,
);

export function Textarea(
  { autoGrow, maxHeight = 260, bare, invalid, className, ref, ...rest }:
    & {
      autoGrow?: boolean;
      maxHeight?: number;
      bare?: boolean;
      invalid?: boolean;
      className?: string;
    }
    & ComponentProps<"textarea">,
): ReactNode {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const grow = () => {
    const el = own.current;
    if (!autoGrow || !el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  };
  useLayoutEffect(grow, [rest.value, autoGrow, maxHeight]);
  return (
    <>
      {SHEET}
      <textarea
        {...rest}
        ref={(el) => {
          own.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        className={cx(
          "copilotz-textarea",
          autoGrow && "copilotz-textarea-grow",
          bare && "copilotz-textarea-bare",
          className,
        )}
        aria-invalid={invalid || rest["aria-invalid"] || undefined}
        onInput={(event) => {
          grow();
          rest.onInput?.(event);
        }}
      />
    </>
  );
}
