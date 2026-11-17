/**
 * A row of controls over what they act on: what's at its `start` (the
 * screen's actions: New, Delete), anything between (`children`), and what's
 * at its `end` (search, filters, a date range), a `grow` item taking the room left between them (a search field), spaced by a step of the
 * toolkit's scale (`gap`, `sm` by default). It wraps when they don't fit,
 * the end's group staying at the end. Named by `label` for screen readers,
 * it's a group they can skip.
 *
 * ```tsx
 * <Toolbar
 *   start={<Button variant="primary" icon="plus">New item</Button>}
 *   end={<DateRangePicker value={range} onChange={setRange} today={today} />}
 * />
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";
import { gapClass, GAPS, type Space } from "./space.tsx";

const SHEET = sheet(
  "toolbar",
  `
.copilotz-toolbar { display: flex; flex-wrap: wrap; align-items: center; min-width: 0;
  padding: var(--toolbar-padding, 0); border-radius: var(--toolbar-radius, 0);
  background: var(--toolbar-background, transparent); }
.copilotz-toolbar-group { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; }
.copilotz-toolbar-grow { flex: 1 1 var(--toolbar-grow-basis, 200px); min-width: 0; }
.copilotz-toolbar-end { margin-left: auto; justify-content: flex-end; }
`,
);

export function Toolbar(
  { start, grow, end, label, gap = "sm", className, children }: {
    start?: ReactNode;
    /** An item that takes the room left between `start` and `end` (a search field). */
    grow?: ReactNode;
    end?: ReactNode;
    /** What it is, said to screen readers ("Items"). */
    label?: string;
    gap?: Space;
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const group = gapClass(gap);
  return (
    <div
      className={cx("copilotz-toolbar", group, className)}
      {...(label ? { role: "group", "aria-label": label } : {})}
    >
      {SHEET}
      {GAPS}
      {start ? <div className={cx("copilotz-toolbar-group", group)}>{start}</div> : null}
      {children}
      {grow ? <div className="copilotz-toolbar-grow">{grow}</div> : null}
      {end
        ? <div className={cx("copilotz-toolbar-group copilotz-toolbar-end", group)}>{end}</div>
        : null}
    </div>
  );
}
