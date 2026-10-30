/**
 * Spaces' layout on the web, on the theme's variables: the sidebar's tree
 * (each space, its fold, what's under it, making one, those archived) and
 * invitations to you, a space's page (its header, an archived space's note,
 * tabs, members, inviting and invitations, settings), the side panel, and
 * the org's sections (About, Members). Only layout: the pieces are the
 * toolkit's.
 */
export const STYLE = `
/* The sidebar: spaces as a tree */
.spaces { list-style: none; display: grid; gap: 1px; margin: 0; padding: 0; }
.spaces-item { display: grid; }
.spaces-row { position: relative; }
.spaces-row > .copilotz-nav-item { padding-right: 36px; }
.spaces-fold { position: absolute; top: 50%; right: 4px; transform: translateY(-50%); color: var(--muted-foreground); }
.spaces-fold .copilotz-icon { transition: transform .15s; }
.spaces-fold[aria-expanded=true] .copilotz-icon { transform: rotate(90deg); }
.spaces-under { position: relative; display: grid; margin: 1px 0 8px 20px; padding-left: 10px; }
.spaces-under::before { content: ""; position: absolute; top: 3px; bottom: 3px; left: 0; width: 1px;
  background: var(--sidebar-border); }
.spaces-under > .copilotz-loading { min-height: 32px; padding: 6px; }
.spaces-personal, .spaces-new-icon { display: grid; place-items: center; flex: none; width: 22px; height: 22px;
  border-radius: var(--radius-full); background: var(--muted); color: var(--secondary-foreground); }
.spaces [aria-current] .spaces-personal { background: var(--card); color: var(--primary-text); }
.spaces-new-icon { border: 1px dashed var(--input); border-radius: var(--radius-sm); background: transparent; }
.spaces-form { margin-top: 2px; }
.spaces-error { margin: 6px 10px 0; color: var(--destructive-text); font-size: 12.5px; }
.spaces-archived { display: grid; margin-top: 4px; }
.spaces-archived-icon { display: grid; place-items: center; flex: none; width: 22px; height: 22px; }
.spaces-archived-end { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.spaces-archived-end .copilotz-icon { transition: transform .15s; }
.spaces-archived[data-open] .spaces-archived-end .copilotz-icon { transform: rotate(90deg); }
.spaces-archived-list { margin: 1px 0 6px 12px; }
.spaces-archived-list .copilotz-avatar { opacity: .75; }

/* Invitations to you: in the sidebar, and on home */
.invitations { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.invitation { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 14px;
  padding: 14px 14px 14px 16px; border-color: var(--primary-border);
  background: color-mix(in oklab, var(--primary-soft) 45%, var(--card)); animation: invitation-in .3s ease-out; }
@keyframes invitation-in { from { opacity: 0; transform: translateY(-4px); } }
.invitation-compact { grid-template-columns: 26px minmax(0, 1fr); align-items: start; gap: 10px;
  margin: 2px 0 4px; padding: 11px 12px; }
.invitation-mark { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--primary-soft); color: var(--primary-text); }
.invitation-text { display: grid; gap: 2px; min-width: 0; }
.invitation-title { margin: 0; font-size: 14.5px; line-height: 1.45; overflow-wrap: anywhere; }
.invitation-compact .invitation-title { font-size: 13.5px; }
.invitation-title b { font-weight: 650; }
.invitation-meta { margin: 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45;
  overflow-wrap: anywhere; }
.invitation-answers { display: flex; flex-wrap: wrap; gap: 6px; }
.invitation-compact .invitation-answers { margin-top: 8px; }
@media (max-width: 600px) {
  .invitation:not(.invitation-compact) { grid-template-columns: auto minmax(0, 1fr); }
  .invitation:not(.invitation-compact) .invitation-answers { grid-column: 2; }
}

/* A space's page */
.space-mark-personal { display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--radius-lg);
  background: var(--primary-soft); color: var(--primary-text); }
.space-rename { color: var(--muted-foreground); }
.space-faces { display: flex; align-items: center; padding: 0 4px 0 6px; border-radius: var(--radius-full);
  text-decoration: none; }
.space-faces > * { margin-left: -6px; outline: 2px solid var(--background); }
.space-faces-more { min-width: 28px; min-height: 28px; }
.space-narrow { display: none; }
.space-tabs { position: sticky; top: 0; z-index: 4; display: flex; width: 100%; margin-top: -2px;
  background: var(--background); -webkit-mask-image: linear-gradient(to right, currentColor calc(100% - 24px), transparent);
  mask-image: linear-gradient(to right, currentColor calc(100% - 24px), transparent); }
.space-tabs .copilotz-tab { padding: 0 10px; }
.space-tab { padding-top: 22px; }
.space-loading { display: grid; gap: 14px; margin-top: 8px; }
.space-missing { display: grid; place-items: center; padding: 32px; }
.space-empty { margin-top: 48px; }
.space-archived { margin: -4px 0 18px; }
@container copilotz-page (max-width: 640px) {
  .space-wide, .space-faces { display: none; }
  .space-narrow { display: inline-grid; }
  .space-mark { --size: 36px !important; }
  .space-mark-personal { width: 36px; height: 36px; border-radius: var(--radius-md); }
}
@media (max-width: 760px) {
  .space-tabs { position: static; }
}

/* Members, and inviting people */
.space-members, .space-settings, .space-inviting { container: space-tab / inline-size; display: grid; gap: 24px; }
.space-inviting { gap: 16px; }
.space-inviting-kind { display: grid; gap: 22px; }
.space-members-compact, .space-settings-compact { gap: 18px; }
.space-section { display: grid; gap: 10px; }
.space-section-title { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted-foreground);
  font-size: 12px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.space-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }
.space-rows { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.space-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  padding: 10px 10px 10px 14px; }
.space-row-asking { border-color: var(--warning-border); }
.space-row-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.space-row-text { display: grid; gap: 1px; min-width: 0; }
.space-row-name { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-weight: 620; }
.space-row-name .copilotz-time { color: var(--muted-foreground); font-size: 12px; font-weight: 450; }
.space-row-what { margin: 0; overflow: hidden; color: var(--muted-foreground); font-size: 12.5px;
  text-overflow: ellipsis; white-space: nowrap; }
.space-row-end { display: flex; align-items: center; gap: 6px; }
.space-row-end > .copilotz-select { min-width: 116px; }
.space-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  min-height: 30px; margin-bottom: -4px; }
.space-section-head .copilotz-button { margin-right: -6px; }
.space-section-about { margin: -2px 2px 2px; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }

/* Agents among the members */
.space-row-face { display: grid; }
.space-row-link { min-width: 0; overflow: hidden; color: inherit; text-decoration: none; text-overflow: ellipsis;
  white-space: nowrap; }
.space-row-link:hover { text-decoration: underline; text-underline-offset: 3px;
  text-decoration-color: color-mix(in oklab, currentColor 35%, transparent); }
.space-row-handle { flex: none; color: var(--muted-foreground); font: 500 12.5px var(--font-mono); }
.space-row-name .copilotz-badge { flex: none; }
.space-row-agent[aria-busy] { opacity: .7; }
.space-agents-none { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px;
  padding: 14px 16px; border-style: dashed; box-shadow: none; background: transparent; }
.space-agents-none p { margin: 0; color: var(--muted-foreground); font-size: 13.5px; }
.space-invite { display: grid; gap: 7px; }
.space-invite-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 8px; }
.space-invite-row > .copilotz-select { min-width: 128px; }
.space-invite-note { margin: 0 2px; color: var(--muted-foreground); font-size: 12.5px; }
.space-invite-note > span { display: inline-flex; align-items: center; gap: 6px; }
.space-row-mail { border-radius: var(--radius-full); background: var(--muted); color: var(--muted-foreground); }
.space-row-email { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space-invite-error { color: var(--destructive-text); }
.space-invite-done { color: var(--success-text); }
@container space-tab (max-width: 520px) {
  .space-row { gap: 10px; padding-left: 12px; }
  .space-row-agent { grid-template-columns: 32px minmax(0, 1fr); }
  .space-row-agent .space-row-end { grid-column: 2; }
  .space-row-agent .space-row-handle { display: none; }
  .space-row-asking { grid-template-columns: 32px minmax(0, 1fr); }
  .space-row-asking .space-row-end { grid-column: 1 / -1; flex-wrap: wrap; }
  .space-invite-row { grid-template-columns: minmax(0, 1fr) auto; }
  .space-invite-row > .copilotz-input { grid-column: 1 / -1; }
}
@container space-tab (max-width: 340px) {
  .space-row { grid-template-columns: 32px minmax(0, 1fr); }
  .space-row-end { grid-column: 2; }
}

/* A message naming agents that don't answer here: over where you type */
.space-not-here-title { display: inline-flex; align-items: center; gap: 8px; }
.space-not-here-faces { display: inline-flex; }
.space-not-here-faces > * + * { margin-left: -5px; outline: 2px solid var(--info-soft); }
@media (max-width: 760px) {
  .space-not-here { flex-wrap: wrap; }
  .space-not-here .copilotz-notice-body { flex-basis: calc(100% - 30px); }
  .space-not-here .copilotz-notice-action { width: 100%; justify-content: flex-end; margin: 2px 0 0; }
}

/* Settings */
.space-setting-list { display: grid; }
.space-setting { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 400px); align-items: start;
  gap: 10px 32px; padding: 18px 20px; }
.space-setting + .space-setting { border-top: 1px solid var(--border); }
.space-setting h3 { margin: 0 0 3px; font-size: 14.5px; font-weight: 650; }
.space-setting-text { margin: 0; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.5; }
.space-setting-control { display: grid; justify-items: start; min-width: 0; }
.space-setting-form { display: grid; gap: 6px; width: 100%; }
.space-setting-inline { display: flex; gap: 8px; }
.space-setting-inline > .copilotz-input { flex: 1; min-width: 0; }
.space-setting-control > .copilotz-input { width: 100%; }
.space-setting-form > .copilotz-select { width: 100%; }
.space-setting-note { display: flex; align-items: center; gap: 6px; margin: 0 2px; font-size: 12.5px; }
.space-setting-about { display: grid; gap: 14px; padding: 18px 20px; }
.space-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 9px 22px; margin: 0;
  font-size: 14px; }
.space-facts dt { color: var(--muted-foreground); }
.space-facts dd { min-width: 0; margin: 0; }
.space-facts-id { display: flex; align-items: center; gap: 6px; }
.space-facts-id code { min-width: 0; overflow: hidden; font-size: 12.5px; text-overflow: ellipsis; white-space: nowrap; }
.space-archive-means { display: grid; gap: 10px; margin: 0; padding: 0 0 0 18px; color: var(--secondary-foreground);
  font-size: 14px; line-height: 1.5; }
.space-archive-means b { color: var(--foreground); font-weight: 620; }
.space-archive-means + .copilotz-notice { margin-top: 14px; }
@container space-tab (max-width: 620px) {
  .space-setting { grid-template-columns: minmax(0, 1fr); padding: 16px; }
  .space-setting-control { justify-items: stretch; }
}

/* In the side panel */
.space-panel { container: space-panel / inline-size; display: flex; flex-direction: column; height: 100%; min-height: 0; }
.space-panel-head { flex: none; display: flex; align-items: center; gap: 10px; min-height: 58px;
  padding: 9px max(10px, var(--copilotz-inset-end, 0px)) 9px 16px; border-bottom: 1px solid var(--border); }
.space-panel-mark { display: grid; place-items: center; flex: none; width: 26px; height: 26px;
  border-radius: var(--radius-full); background: var(--primary-soft); color: var(--primary-text); }
.space-panel-titles { flex: 1; display: grid; min-width: 0; line-height: 1.25; }
.space-panel-titles h2 { margin: 0; overflow: hidden; font-family: var(--font-display); font-size: 15px;
  font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.space-panel-titles span { color: var(--muted-foreground); font-size: 12px; }
.space-panel-tabs { flex: none; align-self: flex-start; max-width: calc(100% - 24px); margin: 10px 12px 0; }
.space-panel-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin;
  scrollbar-color: var(--input) transparent; }
.space-panel-tab { min-height: 100%; padding: 14px 14px 20px; }
.space-panel-tab[hidden] { display: none; }
.space-panel-missing { padding: 24px; color: var(--muted-foreground); }
@container space-panel (max-width: 560px) {
  .space-panel-tabs .copilotz-tab[aria-selected=false] { padding: 0 9px; }
  .space-panel-tabs .copilotz-tab[aria-selected=false] .space-panel-tab-label { position: absolute; width: 1px;
    height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
}

/* The org's sections: its people, and what it is */
.org-row { grid-template-columns: 34px minmax(0, 1fr) auto; }
.org-row-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.org-row-spacer { width: 30px; }
.org-row .space-row-end > .copilotz-badge { min-width: 116px; justify-content: center; }
.org-note { margin: -8px 0 0; }
.org-remove { display: grid; gap: 18px; }
.org-remove-means { list-style: none; display: grid; gap: 10px; margin: 0; padding: 0; color: var(--secondary-foreground);
  font-size: 14px; line-height: 1.5; }
.org-remove-means li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; }
.org-remove-means .copilotz-icon { margin-top: 3px; color: var(--muted-foreground); }
.org-about-role { display: inline-flex; padding-top: 4px; }
.org-about-role .copilotz-badge { gap: 4px; font-size: 12.5px; padding: 3px 10px; }
.org-about-roles { display: grid; gap: 6px; color: var(--secondary-foreground); line-height: 1.5; }
.org-about-roles b { color: var(--foreground); font-weight: 620; }
.org-about-sees .copilotz-notice-body { line-height: 1.55; }
@container space-tab (max-width: 520px) {
  .org-row { grid-template-columns: 34px minmax(0, 1fr); }
  .org-row .space-row-end { grid-column: 2; }
}
`;
