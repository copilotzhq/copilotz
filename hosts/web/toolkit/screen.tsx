/**
 * A frame that fills the window: what it holds (`children`) centred in the
 * window's height and across, at a readable width (`screen-width`, 420px),
 * and an optional `footer` kept at the window's foot. For a route's page
 * (`routePage`) or a front end's own screen that's one card: a sign-in, a
 * landing, an error. It grows past the window when what it holds is taller.
 *
 * ```tsx
 * <Screen footer={<Text tone="muted" size="sm">Acme, 2026</Text>}>
 *   <Card>…the sign-in form…</Card>
 * </Screen>
 * ```
 */
import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { sheet } from "./sheet.tsx";

const SHEET = sheet(
  "screen",
  `
.copilotz-screen { display: flex; flex-direction: column; box-sizing: border-box; min-width: 0;
  min-height: 100vh; min-height: 100dvh; padding: var(--screen-padding, 24px); background: var(--background); }
.copilotz-screen-main { flex: 1 0 auto; display: flex; flex-direction: column; align-items: center;
  justify-content: center; min-width: 0; }
.copilotz-screen-content { width: 100%; max-width: var(--screen-width, 420px); min-width: 0; }
.copilotz-screen-footer { flex: none; width: 100%; max-width: var(--screen-width, 420px); margin: 0 auto;
  padding-top: var(--screen-gap, 24px); text-align: center; }
`,
);

export function Screen(
  { footer, className, children }: {
    /** What sits at the window's foot (a copyright line, links). */
    footer?: ReactNode;
    className?: string;
    children?: ReactNode;
  },
): ReactNode {
  return (
    <div className={cx("copilotz-screen", className)}>
      {SHEET}
      <div className="copilotz-screen-main">
        <div className="copilotz-screen-content">{children}</div>
      </div>
      {footer ? <footer className="copilotz-screen-footer">{footer}</footer> : null}
    </div>
  );
}
