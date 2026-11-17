/**
 * Things in columns: `columns` of equal width (`3`), or as wide as a
 * template says (`"1fr 2fr"`, `"240px 1fr"`), or as many as fit, each at
 * least `min` wide (`min="220px"`: cards, tiles); spaced by a step of the
 * toolkit's scale (`gap`, `md` by default). Narrower than `collapse` (`sm`,
 * 480px, by default; `md`, 720px; `false`, never), it's one column, so a
 * form's two columns stack on a phone. It measures itself, not the window:
 * a grid in a side panel stacks as a phone's does. A child spans more
 * columns in a `GridItem`.
 *
 * ```tsx
 * <Grid columns={2}>
 *   <Field label="First name">…</Field>
 *   <Field label="Last name">…</Field>
 *   <GridItem span={2}><Field label="Address">…</Field></GridItem>
 * </Grid>
 * <Grid min="220px" gap="lg">{cards}</Grid>
 * ```
 */
import { type ComponentProps, createElement, type ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";
import { gapClass, GAPS, type Space } from "./space.tsx";
import type { Align, LayoutElement } from "./stack.tsx";

const SHEET = sheet(
  "grid",
  `
.copilotz-grid-box { container-type: inline-size; min-width: 0; }
.copilotz-grid { display: grid; grid-template-columns: var(--copilotz-grid-columns); margin: 0; padding: 0;
  border: 0; list-style: none; }
.copilotz-grid.copilotz-align-start { align-items: start; }
.copilotz-grid.copilotz-align-center { align-items: center; }
.copilotz-grid.copilotz-align-end { align-items: end; }
.copilotz-grid.copilotz-align-stretch { align-items: stretch; }
.copilotz-grid.copilotz-align-baseline { align-items: baseline; }
.copilotz-grid-item { grid-column: span var(--copilotz-grid-span, 1); min-width: 0; }
@container (max-width: 480px) {
  .copilotz-grid-collapse-sm { grid-template-columns: minmax(0, 1fr); }
  .copilotz-grid-collapse-sm > .copilotz-grid-item { grid-column: auto; }
}
@container (max-width: 720px) {
  .copilotz-grid-collapse-md { grid-template-columns: minmax(0, 1fr); }
  .copilotz-grid-collapse-md > .copilotz-grid-item { grid-column: auto; }
}
`,
);

/** The columns' template: equal ones, the template given, or as many as fit. */
export function columnsOf(columns: number | string | undefined, min: string | undefined): string {
  if (min) return `repeat(auto-fill, minmax(min(${min}, 100%), 1fr))`;
  if (typeof columns === "string") return columns;
  return `repeat(${Math.max(1, Math.floor(columns ?? 2))}, minmax(0, 1fr))`;
}

export function Grid(
  {
    as = "div",
    columns,
    min,
    gap = "md",
    align,
    collapse = "sm",
    className,
    style,
    children,
    ...rest
  }:
    & {
      as?: LayoutElement;
      /** How many equal columns, or a template (`"1fr 2fr"`). Two by default. */
      columns?: number | string;
      /** As many columns as fit, each at least this wide (`"220px"`): over `columns`. */
      min?: string;
      gap?: Space;
      align?: Align;
      /** One column when the grid is narrower than this: `sm` (480px), `md` (720px), or never. */
      collapse?: "sm" | "md" | false;
      className?: string;
      children?: ReactNode;
    }
    & Omit<ComponentProps<"div">, "className" | "children">,
): ReactNode {
  return (
    <div className="copilotz-grid-box">
      {SHEET}
      {GAPS}
      {createElement(
        as,
        {
          ...rest,
          className: cx(
            "copilotz-grid",
            gapClass(gap),
            align && `copilotz-align-${align}`,
            collapse && !min && `copilotz-grid-collapse-${collapse}`,
            className,
          ),
          style: { ...style, "--copilotz-grid-columns": columnsOf(columns, min) },
        },
        children,
      )}
    </div>
  );
}

/** A grid's child that spans more than one column (`span`). */
export function GridItem(
  { span = 1, as = "div", className, style, children, ...rest }:
    & { span?: number; as?: LayoutElement; className?: string; children?: ReactNode }
    & Omit<ComponentProps<"div">, "className" | "children">,
): ReactNode {
  return createElement(
    as,
    {
      ...rest,
      className: cx("copilotz-grid-item", className),
      style: { ...style, "--copilotz-grid-span": String(Math.max(1, Math.floor(span))) },
    },
    SHEET,
    children,
  );
}
