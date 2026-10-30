/**
 * Skills' layout on the web, on the theme's variables: a space's Skills tab
 * (the space's and the app's, each a row), a skill's page (its files as
 * tabs, each read as a page or as code), and the form a skill is written
 * with (from a SKILL.md, or field by field, with its files). Only layout:
 * the pieces are the toolkit's.
 */
export const STYLE = `
/* A space's skills: its tab */
.skills { container: skills / inline-size; display: grid; gap: 18px; }
.skills-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.skills-intro { flex: 1 1 320px; margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.skills-actions { display: flex; gap: 8px; }
.skills-search { width: 100%; }
.skills-group { display: grid; gap: 8px; }
.skills-group h3 { display: flex; align-items: center; gap: 8px; margin: 0 2px; color: var(--muted-foreground);
  font-size: 12px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.skills-group h3 .copilotz-badge { letter-spacing: 0; text-transform: none; }
.skills-list { list-style: none; display: grid; margin: 0; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); }
.skills-item { position: relative; }
.skills-item + .skills-item { border-top: 1px solid var(--border); }
.skills-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  min-height: 64px; padding: 10px 48px 10px 10px; border-radius: var(--radius-lg); color: inherit;
  text-decoration: none; transition: background-color .12s; }
.skills-row:hover { background: var(--accent); }
.skills-row-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.skills-row-icon[data-app] { background: var(--muted); color: var(--secondary-foreground); }
.skills-row-text { display: grid; gap: 3px; min-width: 0; }
.skills-row-name { overflow: hidden; font: 600 14px var(--font-mono); letter-spacing: -.01em; text-overflow: ellipsis;
  white-space: nowrap; }
.skills-row-what { display: -webkit-box; overflow: hidden; color: var(--muted-foreground); font-size: 13px;
  line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.skills-row-meta { display: grid; justify-items: end; gap: 3px; color: var(--muted-foreground); font-size: 12px;
  white-space: nowrap; }
.skills-row-meta .copilotz-time { font-size: 12px; }
.skills-row-menu { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); }
.skills-add { display: grid; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 12px; width: 100%;
  min-height: 64px; padding: 10px; border: 1px dashed var(--input); border-radius: var(--radius-xl);
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer;
  transition: background-color .12s, border-color .12s; }
.skills-add:hover { border-color: var(--primary-border); background: var(--accent); }
.skills-add:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.skills-add-plus { display: grid; place-items: center; width: 36px; height: 36px; border: 1px dashed var(--primary-border);
  border-radius: var(--radius-md); background: var(--primary-soft); color: var(--primary-text); }
.skills-add-say { font-size: 14px; font-weight: 600; }
.skills-none { margin: 4px 2px; color: var(--muted-foreground); font-size: 13px; text-align: center; }
.skills-empty { margin: 28px auto 8px; max-width: 560px; }
.skills-empty .copilotz-empty-text { max-width: 46ch; }
.skills-anatomy { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 0;
  list-style: none; }
.skills-anatomy li { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); font-size: 13px; line-height: 1.45; }
.skills-anatomy b { font-size: 13px; }
.skills-anatomy span { color: var(--muted-foreground); }
.skills-anatomy code { font: 500 12px var(--font-mono); }
.skills-compact { gap: 12px; }
.skills-compact .skills-row { grid-template-columns: minmax(0, 1fr) auto; min-height: 52px; padding: 8px 44px 8px 10px; }
.skills-compact .skills-row-icon, .skills-compact .skills-row-meta { display: none; }
.skills-compact .skills-anatomy { grid-template-columns: 1fr; }
@container skills (max-width: 560px) {
  .skills-row { grid-template-columns: minmax(0, 1fr); padding-left: 12px; }
  .skills-row-icon, .skills-row-meta { display: none; }
  .skills-anatomy { grid-template-columns: 1fr; }
}

/* A skill's page */
.skill-page { display: grid; gap: 16px; }
.skill-files { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.skill-files .copilotz-tabs { max-width: 100%; }
.skill-file-tab { font-family: var(--font-mono); font-size: 12.5px; }
.skill-doc { position: relative; padding: 22px 26px 26px; }
.skill-doc-tools { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px; }
.skill-doc .copilotz-md { max-width: 72ch; padding-right: 64px; }
.skill-doc-code { padding: 0; overflow: hidden; }
.skill-doc-code .copilotz-code { border: 0; border-radius: 0; }
.skill-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 0; color: var(--muted-foreground);
  font-size: 12.5px; }
.skill-meta .copilotz-time { font-size: 12.5px; }
.skill-meta > span + span::before { content: "·"; margin-right: 6px; }
.skill-how { display: grid; gap: 4px; }
.skill-handle { font-family: var(--font-mono); font-weight: 600; }
.skill-missing { display: grid; min-height: 60vh; place-items: center; padding: 24px; }
.skill-loading { display: grid; gap: 14px; }
.skill-delete-means { display: grid; gap: 10px; margin: 0; padding-left: 18px; color: var(--secondary-foreground);
  font-size: 14px; line-height: 1.5; }
@media (max-width: 640px) {
  .skill-doc { padding: 16px 16px 20px; }
  .skill-doc .copilotz-md { padding-right: 0; padding-top: 28px; }
  .skill-wide { display: none; }
}
@media (min-width: 641px) { .skill-narrow { display: none; } }

/* The form a skill is written with */
.skill-form { container: skill-form / inline-size; display: grid; gap: 20px; }
.skill-form :is(input, textarea, select, button) { scroll-margin-bottom: 84px; }
.skill-import { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 12px 14px;
  border: 1.5px dashed var(--input); border-radius: var(--radius-xl);
  background: color-mix(in oklab, var(--muted) 40%, var(--card)); transition: border-color .15s, background-color .15s; }
.skill-import[data-over] { border-color: var(--ring); background: var(--primary-soft); }
.skill-import-say { flex: 1 1 220px; display: grid; gap: 1px; min-width: 0; font-size: 13px; line-height: 1.4; }
.skill-import-say b { font-size: 13.5px; }
.skill-import-say span { color: var(--muted-foreground); }
.skill-import-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.skill-import-done { flex-basis: 100%; margin: 2px 0 0; color: var(--success-text); font-size: 12.5px; }
.skill-import-done[data-tone=warning] { color: var(--warning-text); }
.skill-paste { display: grid; gap: 8px; }
.skill-paste .copilotz-textarea { font: 13px/1.5 var(--font-mono); }
.skill-paste-end { display: flex; justify-content: flex-end; gap: 8px; }
.skill-name .copilotz-input input { font-family: var(--font-mono); font-size: 14px; }
.skill-label-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px;
  margin-bottom: -3px; }
.skill-label { font-size: 13.5px; font-weight: 600; }
.skill-count { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
.skill-count[data-over] { color: var(--destructive-text); }
.skill-field { display: grid; gap: 7px; min-width: 0; }
.skill-note { margin: 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.skill-error { margin: 0; color: var(--destructive-text); font-size: 12.5px; line-height: 1.45; }
.skill-instructions .copilotz-textarea { min-height: 220px; font: 13.5px/1.6 var(--font-mono); }
.skill-preview { min-height: 220px; max-height: 520px; overflow: auto; padding: 14px 16px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); }
.skill-preview-empty { color: var(--muted-foreground); font-size: 13.5px; }
.skill-file-list { list-style: none; display: grid; margin: 0; padding: 0; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); overflow: hidden; }
.skill-file-list:empty { display: none; }
.skill-file + .skill-file { border-top: 1px solid var(--border); }
.skill-file-row { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto auto; align-items: center; gap: 10px;
  min-height: 46px; padding: 6px 6px 6px 12px; }
.skill-file-row > .copilotz-icon { color: var(--muted-foreground); }
.skill-file-path .copilotz-input { min-height: 32px; }
.skill-file-path .copilotz-input input { font-family: var(--font-mono); font-size: 13px; }
.skill-file-size { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.skill-file-body { display: grid; gap: 6px; padding: 0 12px 12px 40px; }
.skill-file-body .copilotz-textarea { font: 13px/1.55 var(--font-mono); }
.skill-file-adds { display: flex; flex-wrap: wrap; gap: 6px; }
.skill-form-end { position: sticky; bottom: -22px; z-index: 1; display: flex; align-items: center; justify-content: flex-end;
  gap: 10px; margin: 0 -22px -22px; padding: 12px 22px 16px; border-top: 1px solid var(--border);
  background: var(--popover); }
.skill-form-end .skill-note, .skill-form-end .skill-error { flex: 1; min-width: 0; }
.skill-page .skill-form-end { position: static; margin: 0; padding: 14px 0 0; background: transparent; }
.skill-edit-card { padding: 20px 22px 22px; }
@container skill-form (max-width: 520px) {
  .skill-file-row { grid-template-columns: 18px minmax(0, 1fr) auto; }
  .skill-file-size { display: none; }
  .skill-file-body { padding-left: 12px; }
}

/* Reading a skill, in a conversation */
.skill-step { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted-foreground);
  font-size: 13px; }
.skill-step a { color: var(--foreground); font: 600 12.5px var(--font-mono); text-decoration: none; }
.skill-step a:hover { text-decoration: underline; text-underline-offset: 3px; }
.skill-step .copilotz-icon { color: var(--primary-text); }
`;
