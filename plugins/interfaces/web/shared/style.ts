/**
 * The shell's layout: a sidebar and a main column, and beside the page, its
 * side panel, when it offers one; on a phone, the sidebar in a drawer (the
 * toolkit's) and a menu button over the page, and the panel a sheet. Only
 * layout, on the theme's variables (see `hosts/web/theme/`). On a phone, a
 * View's own header keeps clear of the menu button by `--copilotz-inset` (the
 * toolkit's `Page` does); a page that offers the panel, and the panel open,
 * keep their header's end clear of its button by `--copilotz-inset-end`.
 * Where the app serves many orgs: the switcher and what it opens, the user
 * menu, going between orgs, staff's line along the top, the org's page and
 * staff's console.
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

/* Orgs: the switcher at the top of the sidebar, beside the app's mark */
.copilotz-sidebar-head[data-orgs] { gap: 4px; padding: 12px 10px 8px 10px; }
.copilotz-brand-mark { flex: none; margin: 0; padding: 8px; color: var(--sidebar-foreground); }
.copilotz-org { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 48px;
  padding: 6px 8px 6px 7px; border: 1px solid transparent; border-radius: var(--radius-lg); background: transparent;
  color: var(--sidebar-foreground); text-align: left; cursor: pointer; transition: background-color .12s, border-color .12s; }
.copilotz-org:hover, .copilotz-org[aria-expanded=true] { background: var(--sidebar-accent); }
.copilotz-org[aria-expanded=true] { border-color: var(--sidebar-border); }
.copilotz-org-text { flex: 1; min-width: 0; display: grid; gap: 1px; line-height: 1.25; }
.copilotz-org-name { overflow: hidden; font-family: var(--font-display); font-size: 14.5px; font-weight: 650;
  letter-spacing: -.01em; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-org-sub { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden;
  color: var(--muted-foreground); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-org[data-staff] .copilotz-org-sub { color: var(--warning-text); font-weight: 620; }
.copilotz-org[data-staff] > .copilotz-avatar { outline: 2px solid var(--warning); outline-offset: 1px; }
.copilotz-org-chevron { flex: none; color: var(--muted-foreground); }
.copilotz-org-dot { flex: none; display: inline-grid; place-items: center; min-width: 19px; height: 19px; padding: 0 6px;
  border-radius: var(--radius-full); background: var(--primary); color: var(--primary-foreground); font-size: 11px;
  font-weight: 700; font-variant-numeric: tabular-nums; }

/* What the switcher opens */
.copilotz-orgs-box { display: grid; gap: 2px; }
.copilotz-orgs-who { margin: 4px 8px 6px; overflow: hidden; color: var(--muted-foreground); font-size: 12.5px;
  text-overflow: ellipsis; white-space: nowrap; }
.copilotz-orgs-who b { color: var(--foreground); font-weight: 600; }
.copilotz-orgs-staff { display: flex; align-items: flex-start; gap: 8px; margin: 0 2px 6px; padding: 9px 10px;
  border: 1px solid var(--warning-border); border-radius: var(--radius-md); background: var(--warning-soft);
  color: var(--warning-text); font-size: 12.5px; line-height: 1.45; }
.copilotz-orgs-staff > .copilotz-icon { margin-top: 1px; }
.copilotz-orgs-staff b { font-weight: 650; }
.copilotz-orgs-list, .copilotz-orgs-invites ul { list-style: none; display: grid; gap: 1px; margin: 0; padding: 0; }
.copilotz-orgs-row, .copilotz-orgs-action { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px;
  padding: 6px 8px; border: 0; border-radius: var(--radius-md); background: transparent; color: inherit;
  font-size: 14px; text-align: left; text-decoration: none; cursor: pointer; outline: none; }
.copilotz-orgs-row:hover, .copilotz-orgs-row:focus-visible, .copilotz-orgs-action:hover,
.copilotz-orgs-action:focus-visible { background: var(--accent); color: var(--accent-foreground); }
.copilotz-orgs-row:focus-visible, .copilotz-orgs-action:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.copilotz-orgs-row[aria-current] { background: color-mix(in oklab, var(--primary-soft) 60%, transparent); }
.copilotz-orgs-row[aria-disabled] { opacity: .62; cursor: not-allowed; }
.copilotz-orgs-row-text { flex: 1; min-width: 0; display: grid; line-height: 1.3; }
.copilotz-orgs-row-name { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-orgs-row-sub { color: var(--muted-foreground); font-size: 12px; }
.copilotz-orgs-row-error { color: var(--destructive-text); font-size: 12px; white-space: normal; }
.copilotz-orgs-check { flex: none; color: var(--primary-text); }
.copilotz-orgs-invites { margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--border); }
.copilotz-orgs-invites h3 { display: flex; align-items: center; gap: 6px; margin: 0 8px 8px; color: var(--muted-foreground);
  font-size: 11.5px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.copilotz-orgs-invites ul { gap: 6px; }
.copilotz-orgs-invite { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; margin: 0 2px; padding: 10px;
  border: 1px solid var(--primary-border); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--primary-soft) 45%, var(--popover)); }
.copilotz-orgs-invite-text { display: grid; gap: 1px; min-width: 0; }
.copilotz-orgs-invite-name { margin: 0; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.copilotz-orgs-invite-meta { margin: 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.copilotz-orgs-invite-meta .copilotz-time { font-size: 12.5px; }
.copilotz-orgs-invite-answers { display: flex; gap: 6px; margin-top: 8px; }
.copilotz-orgs-actions { display: grid; gap: 1px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); }
.copilotz-orgs-action { min-height: 38px; color: var(--secondary-foreground); }
.copilotz-orgs-icon { flex: none; display: grid; place-items: center; width: 28px; height: 28px; color: var(--muted-foreground); }
.copilotz-orgs-icon-new { border: 1px dashed var(--input); border-radius: var(--radius-sm); }

/* Making one */
.copilotz-new-org { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 16px; }
.copilotz-new-org-preview { padding-top: 25px; }

/* Going into another org: over everything, until it's there; and a word once it is */
.copilotz-switching { inset: 0; width: 100%; height: 100%; max-width: none; max-height: none; margin: 0; padding: 0;
  border: 0; background: transparent; color: var(--foreground); outline: none; }
.copilotz-switching::backdrop { background: color-mix(in oklab, var(--background) 84%, transparent);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); animation: copilotz-switching .22s ease-out; }
.copilotz-switching[open] { display: grid; place-items: center; animation: copilotz-switching .22s ease-out; }
.copilotz-switching-box { display: grid; justify-items: center; text-align: center;
  animation: copilotz-switching-in .36s cubic-bezier(.2, .8, .2, 1); }
.copilotz-switching-box .copilotz-avatar { box-shadow: var(--shadow-md); }
.copilotz-switching-personal { display: grid; place-items: center; width: 56px; height: 56px; border-radius: var(--radius-full);
  background: var(--primary-soft); color: var(--primary-text); }
.copilotz-switching-label { margin: 18px 0 2px; color: var(--muted-foreground); font-size: 13px; }
.copilotz-switching-name { margin: 0 0 18px; max-width: min(520px, calc(100vw - 48px)); font-family: var(--font-display);
  font-size: 26px; font-weight: 680; letter-spacing: -.02em; line-height: 1.2; overflow-wrap: anywhere; }
.copilotz-switching .copilotz-spinner { color: var(--muted-foreground); }
@keyframes copilotz-switching { from { opacity: 0; } }
@keyframes copilotz-switching-in { from { opacity: 0; transform: translateY(8px) scale(.97); } }
.copilotz-arrived { position: fixed; z-index: 70; left: 50%; bottom: max(24px, env(safe-area-inset-bottom));
  display: flex; align-items: center; gap: 9px; width: max-content; max-width: min(560px, calc(100vw - 32px));
  padding: 10px 16px;
  border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-lg); font-size: 13.5px; line-height: 1.4;
  pointer-events: none; animation: copilotz-arrived 2.6s ease-in-out forwards; }
.copilotz-arrived b { font-weight: 650; }
.copilotz-arrived > .copilotz-icon { color: var(--success-text); }
.copilotz-arrived[data-long] { border-radius: var(--radius-xl); animation-duration: 5.2s; }
.copilotz-arrived[data-long] > .copilotz-icon { color: var(--info-text); }
.copilotz-arrived[data-staff] { border-color: var(--warning-border); }
.copilotz-arrived[data-staff] > .copilotz-icon { color: var(--warning-text); }
@keyframes copilotz-arrived {
  0% { opacity: 0; transform: translate(-50%, 10px); }
  10%, 88% { opacity: 1; transform: translate(-50%, 0); }
  100% { opacity: 0; transform: translate(-50%, 4px); }
}

/* Staff in someone's org: a line along the top, always */
.copilotz-staff-line { position: fixed; z-index: 80; inset: 0 0 auto; height: 3px; background: var(--warning);
  pointer-events: none; }

/* The user menu */
.copilotz-me-menu { padding: 8px; }
.copilotz-me-button { display: flex; align-items: center; gap: 10px; width: 100%; min-width: 0; padding: 6px 8px;
  border: 0; border-radius: var(--radius-md); background: transparent; color: inherit; text-align: left;
  cursor: pointer; transition: background-color .12s; }
.copilotz-me-button:hover, .copilotz-me-button[aria-expanded=true] { background: var(--sidebar-accent); }
.copilotz-me-chevron { flex: none; color: var(--muted-foreground); }

/* The org's page */
.copilotz-org-held { margin-bottom: 12px; }
.copilotz-org-tabs { position: sticky; top: 0; z-index: 4; display: flex; width: 100%; margin-top: -2px;
  background: var(--background); }
.copilotz-org-tabs .copilotz-tab { padding: 0 10px; }
.copilotz-org-section { padding-top: 22px; }
.copilotz-org-loading { display: grid; gap: 14px; margin-top: 8px; }
.copilotz-org-missing { display: grid; place-items: center; padding: 32px; }
.copilotz-org-page .copilotz-page-badges .copilotz-badge { gap: 4px; }

/* Staff's console: dense, calm */
.console-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.console-stat { display: grid; gap: 2px; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); }
.console-stat-label { color: var(--muted-foreground); font-size: 12px; font-weight: 600; }
.console-stat-value { font-family: var(--font-display); font-size: 24px; font-weight: 650; letter-spacing: -.02em;
  line-height: 1.2; font-variant-numeric: tabular-nums; }
.console-stat[data-tone=warning] .console-stat-value { color: var(--warning-text); }
.console-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;
  margin: 22px 0 12px; }
.console-search { flex: 1 1 280px; max-width: 420px; }
.console-notice { margin-bottom: 12px; }
.console-loading { display: grid; gap: 6px; }
.console-table { container: console / inline-size; display: grid; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); overflow: hidden; }
.console-row { display: grid; grid-template-columns: minmax(220px, 2.4fr) 64px 64px minmax(92px, .9fr) minmax(110px, 1fr) 92px 176px;
  align-items: center; gap: 12px; min-height: 56px; padding: 8px 10px 8px 14px; font-size: 13.5px; }
.console-row + .console-row { border-top: 1px solid var(--border); }
.console-row:not(.console-head):hover { background: color-mix(in oklab, var(--muted) 45%, var(--card)); }
.console-row[data-suspended] { background: color-mix(in oklab, var(--warning-soft) 35%, var(--card)); }
.console-head { min-height: 38px; background: color-mix(in oklab, var(--muted) 55%, var(--card)); color: var(--muted-foreground);
  font-size: 11.5px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; }
.console-num { text-align: right; font-variant-numeric: tabular-nums; }
.console-org { display: flex; align-items: center; gap: 11px; min-width: 0; }
.console-org-text { display: grid; gap: 1px; min-width: 0; }
.console-org-name { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; font-weight: 620;
  text-overflow: ellipsis; white-space: nowrap; }
.console-org-meta { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted-foreground);
  font-size: 12px; }
.console-org-meta code { min-width: 0; overflow: hidden; font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.console-org-meta .copilotz-copy { margin: -4px 0; }
.console-error { color: var(--destructive-text); font-size: 12px; }
.console-active { color: var(--secondary-foreground); }
.console-active .copilotz-time { font-size: 13px; }
.console-placement { display: flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted-foreground); }
.console-placement code { min-width: 0; overflow: hidden; color: var(--secondary-foreground); font-size: 12.5px;
  text-overflow: ellipsis; white-space: nowrap; }
.console-actions { display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.console-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.console-foot { margin: 12px 2px 0; color: var(--muted-foreground); font-size: 12.5px; }
.console-dialog-text { margin: 0 0 12px; color: var(--secondary-foreground); font-size: 14px; line-height: 1.55; }
.console-move { display: grid; gap: 4px; }
.console-move-from { display: flex; align-items: center; gap: 8px; margin: 0 0 14px; color: var(--muted-foreground);
  font-size: 13px; }
.console-move-from code { padding: 2px 8px; border-radius: var(--radius-sm); background: var(--muted);
  color: var(--foreground); font-size: 12.5px; }
.console-mono input { font-family: var(--font-mono); }
.console-delete { display: grid; gap: 14px; }
.console-export { display: inline-flex; align-items: center; gap: 6px; justify-self: start; color: var(--primary-text);
  font-size: 13.5px; font-weight: 560; text-underline-offset: 3px; }
.console-name { font-family: var(--font-mono); font-weight: 650; }
@container console (max-width: 900px) {
  .console-row.console-head { display: none; }
  .console-row > [data-label=Placement] { display: none; }
  .console-row:not([data-suspended]) > [data-label=Status] { display: none; }
  .console-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 12px 10px 12px 14px; }
  .console-row::after { content: ""; order: 1; flex-basis: 100%; height: 0; }
  .console-org { flex: 1 1 0; }
  .console-row > [data-label] { order: 2; color: var(--muted-foreground); font-size: 12.5px; text-align: left; }
  .console-row > [data-label=People] { margin-left: 41px; }
  .console-row > [data-label=People]::before, .console-row > [data-label=Spaces]::before,
  .console-row > [data-label="Last active"]::before { content: attr(data-label) " "; }
  .console-row > [data-label=People]::before, .console-row > [data-label=Spaces]::before,
  .console-row > [data-label="Last active"]::before { color: var(--muted-foreground); }
  .console-row > [data-label] .copilotz-time, .console-row > [data-label] code { color: var(--foreground); font-size: 12.5px; }
  .console-row > .console-num { color: var(--foreground); }
}
@container console (max-width: 520px) {
  .console-actions .copilotz-button { padding: 0 9px; }
}
@media (max-width: 760px) {
  .console-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .console-search { max-width: none; }
  .copilotz-org-tabs { position: static; }
}
`;
