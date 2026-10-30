/**
 * The shell's layout: a sidebar and a main column, and beside the page, its
 * side panel, when it offers one; on a phone, the sidebar in a drawer (the
 * toolkit's) and a menu button over the page, and the panel a sheet. Only
 * layout, on the theme's variables (see `hosts/web/theme/`). On a phone, a
 * View's own header keeps clear of the menu button by `--copilotz-inset` (the
 * toolkit's `Page` does); a page that offers the panel, and the panel open,
 * keep their header's end clear of its button by `--copilotz-inset-end`.
 */
export const STYLE = `
.copilotz-shell { display: grid; grid-template-columns: 280px minmax(0, 1fr); height: 100dvh;
  overflow: clip; background: var(--background); }
.copilotz-sidebar { display: flex; flex-direction: column; min-height: 0; background: var(--sidebar);
  color: var(--sidebar-foreground); border-right: 1px solid var(--sidebar-border); }
.copilotz-sidebar-head { display: flex; align-items: center; justify-content: space-between;
  gap: 8px; padding: 14px 12px 10px 18px; }
.copilotz-brand { display: inline-flex; align-items: center; margin: -6px -8px; padding: 6px 8px;
  border-radius: var(--radius-md); text-decoration: none; transition: background-color .15s; }
.copilotz-brand:hover { background: var(--sidebar-accent); }
.copilotz-find { padding: 0 10px 6px; }
.copilotz-find .copilotz-nav-icon { color: var(--muted-foreground); }
.copilotz-find .copilotz-kbd { font-size: 10.5px; }
.copilotz-sections { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 4px 10px 20px; display: flex; flex-direction: column; gap: 6px; scrollbar-width: thin;
  scrollbar-color: var(--input) transparent; }
.copilotz-section:empty { display: none; }
.copilotz-section + .copilotz-section-titled { margin-top: 14px; }
.copilotz-section > h2 { margin: 0 0 4px; padding: 0 10px; font-family: var(--font-display); font-size: 11.5px;
  font-weight: 650; letter-spacing: .08em; text-transform: uppercase; color: var(--muted-foreground); }
.copilotz-me { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 16px;
  border-top: 1px solid var(--sidebar-border); }
.copilotz-me-who { flex: 1; min-width: 0; display: grid; line-height: 1.25; }
.copilotz-me-name { font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-me-note { font-size: 12px; color: var(--muted-foreground); }
.copilotz-stage { position: relative; display: flex; min-width: 0; min-height: 0; }
.copilotz-main { position: relative; flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0;
  overflow: clip; outline: none; }
.copilotz-main > * { flex: 1; min-height: 0; }
.copilotz-main > .copilotz-failed { flex: none; align-self: center; width: min(560px, calc(100% - 32px));
  margin: max(64px, 12vh) 0 0; }
.copilotz-skip { position: fixed; z-index: 60; top: 10px; left: 10px; transform: translateY(-160%);
  transition: transform .15s; }
.copilotz-skip:focus-visible { transform: none; }
.copilotz-shell-empty { display: grid; place-content: center; padding: 32px; }

/* The side panel: its button over the page's top right, and the panel beside it */
.copilotz-panel-toggle { position: absolute; z-index: 20; top: 11px; right: 12px; color: var(--secondary-foreground); }
.copilotz-panel { flex: none; display: flex; flex-direction: column; min-height: 0;
  width: clamp(320px, var(--copilotz-panel-width, 420px), 58%); overflow: hidden; background: var(--background);
  animation: copilotz-panel-in .2s ease-out; }
.copilotz-panel > * { flex: 1; min-height: 0; }
@keyframes copilotz-panel-in { from { opacity: 0; transform: translateX(14px); } }
.copilotz-drawer-bottom:has(> .copilotz-panel-sheet) { height: 88dvh; max-height: 88dvh; }
.copilotz-panel-sheet { position: relative; display: flex; flex-direction: column; overflow: hidden; }
.copilotz-panel-sheet-head { position: absolute; z-index: 2; inset: 0 0 auto; height: 0; }
.copilotz-panel-grab { position: absolute; top: 7px; left: 50%; width: 38px; height: 4px; margin-left: -19px;
  border-radius: var(--radius-full); background: var(--input); }
.copilotz-panel-close { position: absolute; top: 17px; right: 10px; }
.copilotz-panel-sheet-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden;
  padding-top: 8px; --copilotz-inset-end: 52px; }
.copilotz-panel-sheet-body > * { flex: 1; min-height: 0; }

@media (max-width: 760px) {
  .copilotz-shell { grid-template-columns: minmax(0, 1fr); --copilotz-inset: 56px; }
  .copilotz-sidebar { border-right: 0; }
  .copilotz-shell-menu { position: absolute; z-index: 20; top: 10px; left: 10px; color: var(--secondary-foreground); }
  .copilotz-panel-toggle { top: 10px; right: 10px; }
}
`;
