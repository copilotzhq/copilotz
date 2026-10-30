/**
 * A small label, as a pill: a count, a state, a tag. A `tone` (`neutral`,
 * the default; `primary`, `success`, `warning`, `destructive`, `info`), soft
 * (the default), `outline` or `solid`.
 *
 * ```tsx
 * <Badge>side thread</Badge> <Badge tone="success" variant="solid">Live</Badge>
 * ```
 */
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

export type Tone = "neutral" | "primary" | "success" | "warning" | "destructive" | "info";

const SHEET = sheet(
  "badge",
  `
.copilotz-badge { --tone: var(--muted-foreground); --tone-soft: var(--muted); --tone-border: var(--input);
  --tone-fill: var(--secondary-foreground); --tone-on: var(--secondary);
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-width: 20px;
  padding: 1px 7px; border: 1px solid transparent; border-radius: var(--radius-full);
  background: var(--tone-soft); color: var(--tone); font-size: 11.5px; font-weight: 600; line-height: 1.4;
  letter-spacing: .01em; white-space: nowrap; font-variant-numeric: tabular-nums; }
.copilotz-badge-primary { --tone: var(--primary-text); --tone-soft: var(--primary-soft); --tone-border: var(--primary-border);
  --tone-fill: var(--primary); --tone-on: var(--primary-foreground); }
.copilotz-badge-success { --tone: var(--success-text); --tone-soft: var(--success-soft); --tone-border: var(--success-border);
  --tone-fill: var(--success); --tone-on: var(--success-foreground); }
.copilotz-badge-warning { --tone: var(--warning-text); --tone-soft: var(--warning-soft); --tone-border: var(--warning-border);
  --tone-fill: var(--warning); --tone-on: var(--warning-foreground); }
.copilotz-badge-destructive { --tone: var(--destructive-text); --tone-soft: var(--destructive-soft);
  --tone-border: var(--destructive-border); --tone-fill: var(--destructive); --tone-on: var(--destructive-foreground); }
.copilotz-badge-info { --tone: var(--info-text); --tone-soft: var(--info-soft); --tone-border: var(--info-border);
  --tone-fill: var(--info); --tone-on: var(--info-foreground); }
.copilotz-badge-outline { background: transparent; border-color: var(--tone-border); }
.copilotz-badge-solid { background: var(--tone-fill); color: var(--tone-on); }
`,
);

export function Badge(
  { tone = "neutral", variant = "soft", className, children, ...rest }:
    & { tone?: Tone; variant?: "soft" | "outline" | "solid" }
    & ComponentProps<"span">,
): ReactNode {
  return (
    <>
      {SHEET}
      <span
        {...rest}
        className={cx(
          "copilotz-badge",
          tone !== "neutral" && `copilotz-badge-${tone}`,
          variant !== "soft" && `copilotz-badge-${variant}`,
          className,
        )}
      >
        {children}
      </span>
    </>
  );
}
