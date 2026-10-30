/// <reference lib="dom" />
/**
 * "A new version is ready": a quiet card at the foot of the page once the
 * service worker has a new version of the app (see `install.ts`), to
 * reload into now or later. Nothing moves on its own: what the person is
 * doing stays as it is until they choose.
 */
import type { ReactNode } from "react";
import { later, update, useUpdate } from "./install.ts";
import { Button } from "./toolkit/button.tsx";
import { Icon } from "./toolkit/icon.tsx";
import { IconButton } from "./toolkit/icon-button.tsx";

/** Its layout, the host's own CSS, as a front end's is. */
const STYLE = `
.copilotz-update { position: fixed; z-index: 75; right: 16px; bottom: max(16px, env(safe-area-inset-bottom));
  display: flex; align-items: center; gap: 12px; max-width: min(420px, calc(100vw - 32px)); padding: 10px 8px 10px 14px;
  border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-lg); font-size: 14px;
  animation: copilotz-update .3s cubic-bezier(.2, .8, .2, 1); }
.copilotz-update > .copilotz-icon { flex: none; color: var(--primary-text); }
.copilotz-update p { flex: 1; margin: 0; line-height: 1.4; }
.copilotz-update p span { display: block; color: var(--muted-foreground); font-size: 12.5px; }
@keyframes copilotz-update { from { opacity: 0; transform: translateY(10px); } }
@media (max-width: 760px) {
  .copilotz-update { left: 12px; right: 12px; max-width: none; }
}
`;

/** The app's name: the title the page came with. */
const app = globalThis.document?.title || "Copilotz";

export function UpdateReady(): ReactNode {
  const ready = useUpdate();
  if (!ready) return null;
  return (
    <div className="copilotz-update" role="status">
      <style href="copilotz-update" precedence="copilotz">{STYLE}</style>
      <Icon name="sparkles" size={18} />
      <p>
        A new version of {app} is ready
        <span>Reload to use it; nothing you've done is lost.</span>
      </p>
      <Button size="sm" variant="primary" onClick={update}>Reload</Button>
      <IconButton icon="close" label="Later" size="sm" onClick={later} />
    </div>
  );
}
