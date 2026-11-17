/**
 * What a printed page leaves out, and what only it shows. The page's base
 * already leaves out what's for working the screen (the toolkit's bars,
 * toolbars, a table's ticks and pages, toasts, buttons, what pops over) and
 * prints all of the page, not one screenful; the shell's frame doesn't print
 * either. `NoPrint` marks more of an app's own (a register's keypad, a
 * screen's hints), and `PrintOnly` what shows only on paper (a document's
 * address block, a "printed on" line). `as` makes either an inline `span`.
 *
 * A printed document's own layout (a receipt's 80mm width, an invoice's
 * margins) is the one place an app writes CSS of its own: its `@media print`
 * rules, beside the document.
 *
 * ```tsx
 * <NoPrint><Toolbar start={<Button onClick={() => print()}>{say("print")}</Button>} /></NoPrint>
 * <PrintOnly><Text size="sm">Printed {today}</Text></PrintOnly>
 * ```
 */
import { createElement, type ReactNode } from "react";
import { cx } from "./cx.ts";

/** What a page shows on screen, and never on paper. */
export function NoPrint(
  { as = "div", className, children }: {
    as?: "div" | "span";
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  return createElement(as, { className: cx("copilotz-no-print", className) }, children);
}

/** What a page shows on paper only. */
export function PrintOnly(
  { as = "div", className, children }: {
    as?: "div" | "span";
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  return createElement(as, { className: cx("copilotz-print-only", className) }, children);
}
