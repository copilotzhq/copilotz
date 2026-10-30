/**
 * A formula, from its TeX (as agents write math): MathML that Temml writes,
 * which the browser lays out with its own math font. Inline in text, or on
 * a line of its own (`display`). A formula still being written (`pending`)
 * shows as its source until it's whole, as it does while Temml loads (on the
 * first formula a page shows: a pending one starts it, so it's usually here
 * by the time the formula is whole); TeX it can't read, as its source too,
 * which says why.
 * The MathML is `mathml`'s: only math, whatever the TeX says.
 */
import { type ReactNode, useMemo } from "react";
import { cx } from "./cx.ts";
import { FORMULA_STYLE } from "./formula-style.ts";
import { mathml } from "./mathml.ts";
import { useTemml } from "./temml.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "formula",
  `${FORMULA_STYLE}
.copilotz-formula-display { display: block; margin: 0 0 .9em; padding: 2px 0; overflow-x: auto; overflow-y: hidden; }
.copilotz-formula math { font-size: 1.06em; }
.copilotz-formula-display math { font-size: 1.1em; }
.copilotz-formula-source { font: .86em/1.4 var(--font-mono); font-variant-ligatures: none;
  color: var(--muted-foreground); white-space: pre-wrap; }
`,
);

export function Formula(
  { tex, display = false, pending = false, className }: {
    tex: string;
    display?: boolean;
    pending?: boolean;
    className?: string;
  },
): ReactNode {
  const temml = useTemml();
  const drawn = useMemo(
    () =>
      pending
        ? { error: "Still being written" }
        : temml
        ? mathml(temml, tex, display)
        : { error: "Loading math" },
    [temml, tex, display, pending],
  );
  // A span either way, so a formula on its own line may sit in a paragraph.
  return (
    <span className={cx(display ? "copilotz-formula-display" : "copilotz-formula", className)}>
      {SHEET}
      {"mathml" in drawn
        ? <span dangerouslySetInnerHTML={{ __html: drawn.mathml }} />
        : (
          <code className="copilotz-formula-source" title={drawn.error}>
            {display ? tex : `$${tex}$`}
          </code>
        )}
    </span>
  );
}
