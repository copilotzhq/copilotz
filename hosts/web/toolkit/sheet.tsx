/**
 * A toolkit piece's stylesheet: CSS in a string, in the toolkit's layer (so a
 * front end's own CSS always wins over it), hoisted into the page once by
 * React however many times the piece renders. Each one says the layers'
 * order first (the page's base, then the toolkit), so the toolkit's layer
 * stays over the base's wherever its sheets land in the page: React may put
 * them before a page's own base (a page served without the web host).
 * Made once, where the piece is declared:
 *
 * ```tsx
 * const SHEET = sheet("badge", `.copilotz-badge { … }`);
 * export const Badge = (…) => <>{SHEET}<span className="copilotz-badge">…</span></>;
 * ```
 */
import type { ReactElement } from "react";

export const sheet = (name: string, css: string): ReactElement => (
  <style href={`copilotz-${name}`} precedence="copilotz">
    {`@layer copilotz-base, copilotz-toolkit;\n@layer copilotz-toolkit {\n${css}\n}`}
  </style>
);
