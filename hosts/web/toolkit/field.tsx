/**
 * A labelled control: its `label`, the control (given its `id`, what
 * describes it, and whether it's invalid), and a `hint` under it, or the
 * `error` in its place. `required` marks the label (said to screen readers
 * too). The control is a function of what the field gives it, or the
 * control itself, named by `htmlFor` (the field then marks it invalid by
 * its look).
 *
 * Stacked, the label over the control (the default); or `layout="row"`, the
 * label in a column beside it (`labelWidth`, and `controlWidth` for a
 * narrower control), stacked again on a narrow screen. Its look is the
 * theme's: `field-gap`, `field-label-*`, `field-required-color`,
 * `field-row-label-width`, `field-row-gap`…
 *
 * ```tsx
 * <Field label="Your name" hint="Anyone you name here is a person." error={bad}>
 *   {(control) => <Input {...control} value={name} onChange={…} />}
 * </Field>
 * <Field layout="row" label="Email" htmlFor="email" required>
 *   <Input id="email" type="email" icon="mail" … />
 * </Field>
 * ```
 */
import { type CSSProperties, type ReactNode, useId } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

/** What a field gives its control. */
export type Control = { id: string; "aria-describedby"?: string; "aria-invalid"?: true };

const SHEET = sheet(
  "field",
  `
.copilotz-field { display: grid; align-content: start; gap: var(--field-gap, 7px); }
.copilotz-field-label { font-size: var(--field-label-font-size, 13.5px);
  font-weight: var(--field-label-font-weight, 600); color: var(--field-label-color, var(--foreground)); }
.copilotz-field-mark { margin-inline-start: 3px; color: var(--field-required-color, var(--destructive-text)); }
.copilotz-field-note { margin: 0; font-size: var(--field-note-font-size, 12.5px); line-height: 1.45;
  color: var(--muted-foreground); }
.copilotz-field-error { color: var(--destructive-text); }
.copilotz-field[data-invalid] :is(.copilotz-input, .copilotz-select > select, .copilotz-textarea) {
  border-color: var(--destructive); }
.copilotz-field-control { display: grid; align-content: start; gap: var(--field-gap, 7px); min-width: 0;
  max-width: var(--field-row-control-width, none); }
.copilotz-field-row { grid-template-columns: var(--field-row-label-width, 30%) minmax(0, 1fr);
  column-gap: var(--field-row-gap, 16px); align-items: first baseline; }
.copilotz-field-row > .copilotz-field-label { padding-top: var(--field-row-label-offset, 0);
  text-align: var(--field-row-label-align, start); overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .copilotz-field-row { grid-template-columns: minmax(0, 1fr); }
  .copilotz-field-row > .copilotz-field-label { padding-top: 0; text-align: start; }
}
`,
);

export function Field(
  {
    label,
    hint,
    error,
    required,
    htmlFor,
    layout = "stacked",
    labelWidth,
    controlWidth,
    className,
    children,
  }: {
    label: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    /** Marks the label: a value is needed. */
    required?: boolean;
    /** The control's id, when the control is given as it is rather than as a function. */
    htmlFor?: string;
    /** The label over the control, or in a column beside it. */
    layout?: "stacked" | "row";
    /** In a row, the label's column: a length or a share (`"160px"`, `"25%"`). */
    labelWidth?: string;
    /** In a row, the most the control takes (`"33%"`): a narrower control. */
    controlWidth?: string;
    className?: string;
    children: ReactNode | ((control: Control) => ReactNode);
  },
): ReactNode {
  const own = useId();
  const id = typeof children === "function" ? own : htmlFor;
  const note = error || hint;
  const noteId = `${own}-note`;
  const control = typeof children === "function"
    ? children({
      id: own,
      ...(note ? { "aria-describedby": noteId } : {}),
      ...(error ? { "aria-invalid": true } : {}),
    })
    : children;
  const said = note
    ? (
      <p id={noteId} className={cx("copilotz-field-note", !!error && "copilotz-field-error")}>
        {note}
      </p>
    )
    : null;
  const row = layout === "row";
  const widths = {
    ...(labelWidth ? { "--field-row-label-width": labelWidth } : {}),
    ...(controlWidth ? { "--field-row-control-width": controlWidth } : {}),
  } as CSSProperties;
  return (
    <div
      className={cx("copilotz-field", row && "copilotz-field-row", className)}
      data-invalid={error ? true : undefined}
      style={row && (labelWidth || controlWidth) ? widths : undefined}
    >
      {SHEET}
      <label className="copilotz-field-label" htmlFor={id}>
        {label}
        {required
          ? (
            <>
              <span className="copilotz-field-mark" aria-hidden="true">*</span>
              <span className="copilotz-sr">, {say("required")}</span>
            </>
          )
          : null}
      </label>
      {row
        ? (
          <div className="copilotz-field-control">
            {control}
            {said}
          </div>
        )
        : (
          <>
            {control}
            {said}
          </>
        )}
    </div>
  );
}
