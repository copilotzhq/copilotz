/**
 * Things one after another: down the page (`direction="column"`, the
 * default) or along a line (`row`), spaced by a step of the toolkit's scale
 * (`gap`, `md` by default; see `space.tsx`), aligned across (`align`) and
 * along (`justify`), wrapping when they don't fit (`wrap`). It's how a
 * screen lays out its parts without CSS: a form's rows, a header's title
 * and buttons, a column of cards. `as` makes it another element (a `form`,
 * a `section`, a list), and every other prop is that element's.
 *
 * `Spacer` takes the room left in a row, pushing what follows it to the
 * end; `Divider` is a line between parts (across a column, or down a row).
 *
 * ```tsx
 * <Stack gap="lg">
 *   <Stack direction="row" align="center" gap="sm">
 *     <Heading level={2}>Items</Heading><Spacer /><Button variant="primary">New item</Button>
 *   </Stack>
 *   <DataTable … />
 * </Stack>
 * <Stack as="form" onSubmit={save}>…</Stack>
 * ```
 */
import { type ComponentProps, createElement, type ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";
import { gapClass, GAPS, type Space } from "./space.tsx";

/** The elements a layout piece may be. */
export type LayoutElement =
  | "div"
  | "section"
  | "article"
  | "aside"
  | "header"
  | "footer"
  | "main"
  | "nav"
  | "form"
  | "fieldset"
  | "ul"
  | "ol"
  | "li";

/** What a layout piece made a `form` (`as="form"`) also takes: where and how it's sent. */
export type FormAttributes = Partial<
  Pick<
    ComponentProps<"form">,
    "action" | "method" | "encType" | "noValidate" | "target" | "autoComplete"
  >
>;

/** How things line up: at the start, the centre, the end, stretched, or on their text's baseline. */
export type Align = "start" | "center" | "end" | "stretch" | "baseline";

/** Where the room left goes: things at the start, centre or end, or spread between them. */
export type Justify = "start" | "center" | "end" | "between";

const SHEET = sheet(
  "stack",
  `
.copilotz-stack { display: flex; flex-direction: column; min-width: 0; margin: 0; padding: 0; border: 0; }
.copilotz-stack-row { flex-direction: row; }
.copilotz-stack-wrap { flex-wrap: wrap; }
ul.copilotz-stack, ol.copilotz-stack { list-style: none; }
.copilotz-align-start { align-items: flex-start; }
.copilotz-align-center { align-items: center; }
.copilotz-align-end { align-items: flex-end; }
.copilotz-align-stretch { align-items: stretch; }
.copilotz-align-baseline { align-items: baseline; }
.copilotz-justify-start { justify-content: flex-start; }
.copilotz-justify-center { justify-content: center; }
.copilotz-justify-end { justify-content: flex-end; }
.copilotz-justify-between { justify-content: space-between; }
.copilotz-spacer { flex: 1 1 0; min-width: 0; }
.copilotz-divider { flex: none; align-self: stretch; margin: 0; border: 0;
  border-top: var(--divider-width, 1px) solid var(--divider-color, var(--border)); }
.copilotz-stack-row > .copilotz-divider { border-top: 0;
  border-left: var(--divider-width, 1px) solid var(--divider-color, var(--border)); }
`,
);

export function Stack(
  {
    as = "div",
    direction = "column",
    gap = "md",
    align,
    justify,
    wrap,
    className,
    children,
    ...rest
  }:
    & {
      as?: LayoutElement;
      direction?: "column" | "row";
      gap?: Space;
      align?: Align;
      justify?: Justify;
      wrap?: boolean;
      className?: string;
      children?: ReactNode;
    }
    & Omit<ComponentProps<"div">, "className" | "children" | "autoComplete">
    & FormAttributes,
): ReactNode {
  return createElement(
    as,
    {
      ...rest,
      className: cx(
        "copilotz-stack",
        direction === "row" && "copilotz-stack-row",
        wrap && "copilotz-stack-wrap",
        gapClass(gap),
        align && `copilotz-align-${align}`,
        justify && `copilotz-justify-${justify}`,
        className,
      ),
    },
    SHEET,
    GAPS,
    children,
  );
}

/** The room left in a row: what follows it goes to the row's end. */
export function Spacer(): ReactNode {
  return (
    <>
      {SHEET}
      <span className="copilotz-spacer" aria-hidden="true" />
    </>
  );
}

/** A line between parts: across a column, or down a row. */
export function Divider({ className }: { className?: string }): ReactNode {
  return (
    <>
      {SHEET}
      <hr className={cx("copilotz-divider", className)} />
    </>
  );
}
