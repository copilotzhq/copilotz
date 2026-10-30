/**
 * Nothing here yet, or nothing to see: an icon in a soft tile (`neutral`, or
 * `primary` when it invites), a `title` (an `h2`, or the page's `h1`), why,
 * and what to do (`action`).
 *
 * ```tsx
 * <EmptyState icon="sparkles" tone="primary" title="Nothing remembered yet"
 *   action={<Button variant="primary" href="/">Start a conversation</Button>}>
 *   As you talk, agents keep here what will matter later.
 * </EmptyState>
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "empty-state",
  `
.copilotz-empty { display: grid; justify-items: center; gap: 8px; max-width: 420px; margin: 0 auto;
  text-align: center; }
.copilotz-empty-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 10px;
  border: 1px solid var(--border); border-radius: var(--radius-2xl); background: var(--muted);
  color: var(--muted-foreground); }
.copilotz-empty-primary .copilotz-empty-icon { border-color: transparent; background: var(--primary-soft);
  color: var(--primary-text); }
.copilotz-empty-title { margin: 0; font-family: var(--font-display); font-size: 20px; line-height: 1.25;
  font-weight: 650; letter-spacing: -.015em; color: var(--foreground); }
h1.copilotz-empty-title { font-size: 21px; }
.copilotz-empty-text { margin: 0; color: var(--muted-foreground); }
.copilotz-empty-action { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 12px; }
`,
);

export function EmptyState(
  { icon, tone = "neutral", title, heading = "h2", id, action, className, children }: {
    icon?: IconName;
    tone?: "neutral" | "primary";
    title: ReactNode;
    heading?: "h1" | "h2" | "h3";
    /** The title's id, for what it labels. */
    id?: string;
    action?: ReactNode;
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const Heading = heading;
  return (
    <div
      className={cx("copilotz-empty", tone === "primary" && "copilotz-empty-primary", className)}
    >
      {SHEET}
      {icon
        ? (
          <span className="copilotz-empty-icon">
            <Icon name={icon} size={24} />
          </span>
        )
        : null}
      <Heading id={id} className="copilotz-empty-title">{title}</Heading>
      {children ? <p className="copilotz-empty-text">{children}</p> : null}
      {action ? <div className="copilotz-empty-action">{action}</div> : null}
    </div>
  );
}
