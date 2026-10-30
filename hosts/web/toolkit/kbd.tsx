/** A key to press, as a keycap: `<Kbd>Enter</Kbd>`, `<Kbd>⌘K</Kbd>`. */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "kbd",
  `
.copilotz-kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 19px;
  padding: 0 5px; border: 1px solid var(--input); border-radius: var(--radius-xs);
  background: color-mix(in oklab, var(--muted) 50%, var(--background)); color: var(--muted-foreground);
  font: 600 10.5px/1 var(--font-sans); white-space: nowrap; }
`,
);

export function Kbd(
  { children, className }: { children: ReactNode; className?: string },
): ReactNode {
  return (
    <>
      {SHEET}
      <kbd className={cx("copilotz-kbd", className)}>{children}</kbd>
    </>
  );
}
