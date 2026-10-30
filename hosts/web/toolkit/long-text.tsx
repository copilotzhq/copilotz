/**
 * Text that may run long: its first `lines` (4), and a "Show more" that
 * shows the rest (and "Show less" after). Line breaks are kept. Text short
 * enough to show whole has no toggle.
 *
 * ```tsx
 * <LongText text={note.body} />
 * ```
 */
import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { Button } from "./button.tsx";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "long-text",
  `
.copilotz-long-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.copilotz-long-text-clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--lines);
  overflow: hidden; }
.copilotz-long-text-toggle { margin-top: 4px; font-size: 13px; }
`,
);

/** Whether text needs a toggle to be read whole: longer than a few lines would hold. */
const long = (text: string, lines: number) =>
  text.length > lines * 70 || text.split("\n").length > lines;

export function LongText(
  { text, lines = 4, className }: { text: string; lines?: number; className?: string },
): ReactNode {
  const [open, setOpen] = useState(false);
  const id = useId();
  const clamps = long(text, lines);
  return (
    <>
      {SHEET}
      <div
        id={id}
        className={cx(
          "copilotz-long-text",
          clamps && !open && "copilotz-long-text-clamped",
          className,
        )}
        style={clamps ? { "--lines": lines } as CSSProperties : undefined}
      >
        {text}
      </div>
      {clamps
        ? (
          <Button
            variant="link"
            size="sm"
            className="copilotz-long-text-toggle"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(!open)}
          >
            {open ? "Show less" : "Show more"}
          </Button>
        )
        : null}
    </>
  );
}
