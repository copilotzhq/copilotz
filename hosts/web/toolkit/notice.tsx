/**
 * Something to know, in a tinted box: `info` (the default), `success`,
 * `warning`, `destructive` or `neutral`, with the tone's icon (another, or
 * none: `icon={false}`). Plain words take the tone's color; under a `title`,
 * they're quieter. An `action` (a button) sits at its end. `role="alert"`
 * when it reports a failure as it happens.
 *
 * ```tsx
 * <Notice tone="warning" icon="lock" action={<Button size="sm">Share</Button>}>
 *   Uses <b>Finance</b>. Not everyone here can see it.
 * </Notice>
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { Icon, type IconName } from "./icon.tsx";
import { sheet } from "./sheet.tsx";

const ICONS: Record<string, IconName> = {
  info: "info",
  neutral: "info",
  success: "check-circle",
  warning: "alert",
  destructive: "alert",
};

const SHEET = sheet(
  "notice",
  `
.copilotz-notice { --tone: var(--info); --tone-text: var(--info-text); --tone-soft: var(--info-soft);
  --tone-border: var(--info-border);
  display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--tone-border);
  border-radius: var(--radius-lg); background: var(--tone-soft); color: var(--tone-text); font-size: 14px;
  line-height: 1.45; }
.copilotz-notice > .copilotz-icon { margin-top: 1px; color: var(--tone); }
.copilotz-notice-neutral { --tone: var(--muted-foreground); --tone-text: var(--secondary-foreground);
  --tone-soft: var(--muted); --tone-border: var(--border); }
.copilotz-notice-success { --tone: var(--success); --tone-text: var(--success-text); --tone-soft: var(--success-soft);
  --tone-border: var(--success-border); }
.copilotz-notice-warning { --tone: var(--warning); --tone-text: var(--warning-text); --tone-soft: var(--warning-soft);
  --tone-border: var(--warning-border); }
.copilotz-notice-destructive { --tone: var(--destructive); --tone-text: var(--destructive-text);
  --tone-soft: var(--destructive-soft); --tone-border: var(--destructive-border); }
.copilotz-notice-body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.copilotz-notice-title { display: block; font-weight: 600; color: var(--foreground); }
.copilotz-notice-title + .copilotz-notice-text { margin-top: 2px; color: var(--secondary-foreground); }
.copilotz-notice-text b, .copilotz-notice-text strong { font-weight: 650; }
.copilotz-notice-action { flex: none; align-self: center; display: flex; gap: 6px; margin: -4px -4px -4px 0; }
`,
);

export function Notice(
  { tone = "info", title, icon, action, role, className, children }: {
    tone?: "info" | "success" | "warning" | "destructive" | "neutral";
    title?: ReactNode;
    icon?: IconName | false;
    action?: ReactNode;
    role?: "alert" | "status";
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  const glyph = icon === false ? null : icon ?? ICONS[tone];
  return (
    <div
      role={role}
      className={cx("copilotz-notice", tone !== "info" && `copilotz-notice-${tone}`, className)}
    >
      {SHEET}
      {glyph ? <Icon name={glyph} size={16} /> : null}
      <div className="copilotz-notice-body">
        {title ? <strong className="copilotz-notice-title">{title}</strong> : null}
        {children ? <div className="copilotz-notice-text">{children}</div> : null}
      </div>
      {action ? <div className="copilotz-notice-action">{action}</div> : null}
    </div>
  );
}
