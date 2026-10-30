/**
 * A labelled control: its `label`, the control (given its `id`, what
 * describes it, and whether it's invalid), and a `hint` under it, or the
 * `error` in its place.
 *
 * ```tsx
 * <Field label="Your name" hint="Anyone you name here is a person." error={bad}>
 *   {(control) => <Input {...control} value={name} onChange={…} />}
 * </Field>
 * ```
 */
import { type ReactNode, useId } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

/** What a field gives its control. */
export type Control = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

const SHEET = sheet(
  "field",
  `
.copilotz-field { display: grid; align-content: start; gap: 7px; }
.copilotz-field-label { font-size: 13.5px; font-weight: 600; color: var(--foreground); }
.copilotz-field-note { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--muted-foreground); }
.copilotz-field-error { color: var(--destructive-text); }
`,
);

export function Field(
  { label, hint, error, className, children }: {
    label: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    className?: string;
    children(control: Control): ReactNode;
  },
): ReactNode {
  const id = useId();
  const note = error || hint;
  return (
    <div className={cx("copilotz-field", className)}>
      {SHEET}
      <label className="copilotz-field-label" htmlFor={id}>{label}</label>
      {children({
        id,
        ...(note ? { "aria-describedby": `${id}-note` } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {note
        ? (
          <p
            id={`${id}-note`}
            className={cx("copilotz-field-note", !!error && "copilotz-field-error")}
          >
            {note}
          </p>
        )
        : null}
    </div>
  );
}
