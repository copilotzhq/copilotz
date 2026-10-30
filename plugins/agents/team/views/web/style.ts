/**
 * Agents' layout on the web, on the theme's variables: adding one to a
 * space (those someone knows, and making one), the form an agent is made
 * and changed with (its emoji, its instructions being written, its tools),
 * what making one says after, and an agent's page (where it works, what
 * it's told, what it uses, changing and deleting it). Only layout: the
 * pieces are the toolkit's.
 */
export const STYLE = `
/* Adding an agent to a space */
.agent-add { container: agent-add / inline-size; display: grid; gap: 14px; }
.agent-known { display: grid; gap: 12px; }
.agent-known-tools { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.agent-known-find { flex: 1; min-width: 0; }
.agent-known-intro { margin: 0; color: var(--muted-foreground); font-size: 13px; }
.agent-known-role { flex: none; display: inline-flex; align-items: center; gap: 8px; color: var(--muted-foreground);
  font-size: 13px; }
.agent-known-role .copilotz-select { min-width: 112px; }
.agent-known-list { list-style: none; display: grid; margin: 0; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); max-height: min(420px, 52vh); overflow-y: auto;
  scrollbar-width: thin; }
.agent-known-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  width: 100%; min-height: 56px; padding: 8px 8px 8px 10px; border: 0; border-radius: var(--radius-lg);
  background: transparent; color: inherit; font: inherit; text-align: left; }
.agent-known-row + .agent-known-row, li + .agent-known-row { border-top: 1px solid var(--border); border-radius: 0; }
.agent-known-new { cursor: pointer; transition: background-color .12s; }
.agent-known-new:hover { background: var(--accent); }
.agent-known-new > .copilotz-icon { color: var(--muted-foreground); margin-right: 6px; }
.agent-known-plus { display: grid; place-items: center; width: 34px; height: 34px; border: 1px dashed var(--primary-border);
  border-radius: var(--radius-md); background: var(--primary-soft); color: var(--primary-text); }
.agent-known-text { display: grid; gap: 1px; min-width: 0; line-height: 1.35; }
.agent-known-name { overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.agent-known-what { overflow: hidden; color: var(--muted-foreground); font-size: 12.5px; text-overflow: ellipsis;
  white-space: nowrap; }
.agent-known-from { margin-left: 8px; color: var(--muted-foreground); font-size: 12px; font-weight: 450; }
.agent-known-from::before { content: "·"; margin-right: 8px; }
.agent-known-none { margin: 0 2px; color: var(--muted-foreground); font-size: 13px; text-align: center; }
.agent-handle { color: var(--muted-foreground); font: 500 12px var(--font-mono); }
.agent-form-note b.agent-handle, .copilotz-field-note b.agent-handle { color: var(--secondary-foreground); }
.agent-done { display: inline-flex; align-items: center; gap: 6px; color: var(--success-text); }
.agent-error { color: var(--destructive-text); }
@container agent-add (max-width: 420px) {
  .agent-known-tools { flex-wrap: wrap; }
  .agent-known-find { flex-basis: 100%; }
  .agent-known-from { display: block; margin-left: 0; }
  .agent-known-from::before { content: none; }
}

/* Making one */
.agent-new { display: grid; gap: 20px; }
.agent-new :is(input, textarea, select, button) { scroll-margin-bottom: 84px; }
.agent-new-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: -4px; }
.agent-new-top > .copilotz-button { margin-left: -8px; }
.agent-new-from { display: inline-flex; align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 13px; }
.agent-new-from .copilotz-select { min-width: 170px; }
.agent-new-end { position: sticky; bottom: -22px; z-index: 1; display: flex; align-items: center; justify-content: flex-end;
  gap: 14px; margin: 0 -22px -22px; padding: 12px 22px 16px; border-top: 1px solid var(--border);
  background: var(--popover); }
.agent-new-end .agent-form-note { flex: 1; min-width: 0; }
.agent-new-end .agent-form-note:empty { visibility: hidden; }

/* The form: who it is, what it does, what it's told, what it uses */
.agent-form { display: grid; gap: 20px; }
.agent-form-who { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 16px; }
.agent-form-who > .copilotz-avatar { margin-top: 22px; box-shadow: var(--shadow-sm); }
.agent-face-empty { display: grid; place-items: center; width: 56px; height: 56px; margin-top: 22px;
  border: 1.5px dashed var(--input); border-radius: var(--radius-xl); background: var(--muted);
  color: var(--muted-foreground); }
.agent-form-field { display: grid; gap: 7px; min-width: 0; }
.agent-form-label { font-size: 13.5px; font-weight: 600; color: var(--foreground); }
.agent-form-label-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 30px;
  margin: -4px 0 -3px; }
.agent-form-label-row > .copilotz-button { margin-right: -6px; }
.agent-form-count { margin-left: 6px; color: var(--muted-foreground); font-weight: 500; font-variant-numeric: tabular-nums; }
.agent-form-note { margin: 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.agent-undo { min-height: 0; padding: 0; vertical-align: baseline; }
.agent-icons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.agent-icon { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--border);
  border-radius: var(--radius-md); background: var(--card); color: var(--secondary-foreground); font-size: 18px;
  line-height: 1; cursor: pointer; transition: background-color .12s, border-color .12s, transform .12s; }
.agent-icon:hover:not(:disabled) { background: var(--accent); transform: translateY(-1px); }
.agent-icon[aria-checked=true] { border-color: var(--ring); background: var(--primary-soft);
  outline: 2px solid color-mix(in oklab, var(--ring) 22%, transparent); }
.agent-icon:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.agent-icon-none { font-size: 13px; font-weight: 650; }
.agent-icon-own { width: 84px; height: 36px; }
.agent-icon-own:has(input[data-chosen]) { border-color: var(--ring); background: var(--primary-soft); }
.agent-instructions { position: relative; }
.agent-instructions .copilotz-textarea { font-size: 14px; line-height: 1.55; }
.agent-instructions[data-busy] .copilotz-textarea { color: transparent; }
.agent-drafting { position: absolute; inset: 1px; display: grid; align-content: start; gap: 10px; overflow: hidden;
  padding: 12px 14px; border-radius: var(--radius-lg); background: color-mix(in oklab, var(--card) 94%, transparent);
  animation: agent-fade .2s ease-out; }
.agent-drafting-say { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 2px; color: var(--primary-text);
  font-size: 13px; font-weight: 560; }
@keyframes agent-fade { from { opacity: 0; } }
.agent-tools { display: grid; gap: 6px; padding: 6px 6px 8px 12px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: color-mix(in oklab, var(--muted) 35%, var(--card)); }
.agent-tools ul { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px; margin: 0; padding: 0; max-height: 260px; overflow-y: auto; scrollbar-width: thin; }
.agent-tools-all { display: flex; gap: 12px; }
.agent-tools-all .copilotz-button { min-height: 26px; padding: 0; }
.agent-tool { display: grid; gap: 1px; }
.agent-tool code { font: 600 12.5px var(--font-mono); }
.agent-tool span { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.4; }
.agent-tools-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 0; color: var(--muted-foreground);
  font-size: 12.5px; }
.agent-tools-line code { padding: 2px 7px; border-radius: var(--radius-full); background: var(--muted);
  color: var(--secondary-foreground); font: 500 12px var(--font-mono); }

/* Made: what's next */
.agent-made { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 16px; padding: 18px;
  border: 1px solid var(--success-border); border-radius: var(--radius-xl);
  background: color-mix(in oklab, var(--success-soft) 55%, var(--card)); animation: agent-rise .25s ease-out; }
@keyframes agent-rise { from { opacity: 0; transform: translateY(4px); } }
.agent-made-face { position: relative; }
.agent-made-check { position: absolute; right: -4px; bottom: -4px; display: grid; place-items: center; width: 20px;
  height: 20px; border: 2px solid var(--card); border-radius: var(--radius-full); background: var(--success);
  color: var(--success-foreground); }
.agent-made-text { display: grid; gap: 4px; min-width: 0; }
.agent-made-text h3 { margin: 0; font-family: var(--font-display); font-size: 16px; font-weight: 650; }
.agent-made-text p { margin: 0; color: var(--secondary-foreground); font-size: 13.5px; }
.agent-made-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }

/* An agent's page */
.agent-mark { box-shadow: var(--shadow-sm); }
.agent-narrow { display: none; }
@container copilotz-page (max-width: 640px) {
  .agent-wide { display: none; }
  .agent-narrow { display: inline-grid; }
  .agent-mark { --size: 40px !important; }
}
.agent-page-handle { font: 500 12px var(--font-mono); }
.agent-page { display: grid; gap: 26px; }
.agent-page-error { margin-bottom: 16px; }
.agent-page-note { display: flex; align-items: center; gap: 7px; margin: -6px 0 -8px; color: var(--muted-foreground);
  font-size: 13px; }
.agent-section { display: grid; gap: 10px; }
.agent-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px;
  margin-bottom: -4px; }
.agent-section-head .copilotz-button { margin-right: -6px; }
.agent-section-title { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted-foreground);
  font-size: 12px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.agent-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }
.agent-seats { list-style: none; display: grid; margin: 0; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); box-shadow: var(--shadow-sm); }
.agent-seat { display: flex; align-items: center; gap: 12px; min-height: 48px; padding: 8px 12px 8px 10px;
  border-radius: var(--radius-lg); color: inherit; text-decoration: none; transition: background-color .12s; }
.agent-seat:hover { background: var(--accent); }
.agent-seat > .copilotz-icon { color: var(--muted-foreground); }
.agent-seat-personal { display: grid; place-items: center; flex: none; width: 28px; height: 28px;
  border-radius: var(--radius-md); background: var(--primary-soft); color: var(--primary-text); }
.agent-seat-name { flex: 1; min-width: 0; overflow: hidden; font-weight: 580; text-overflow: ellipsis; white-space: nowrap; }
.agent-none { margin: 0; color: var(--muted-foreground); font-size: 13.5px; }
.agent-instructions-read { font-size: 14.5px; line-height: 1.6; }
.agent-tool-list { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 10px 22px; margin: 0; padding: 0; }
.agent-tool-list li { display: grid; gap: 1px; min-width: 0; }
.agent-tool-list code { font: 600 12.5px var(--font-mono); }
.agent-tool-list span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden;
  color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.agent-tool-list span:empty { display: none; }
.agent-tools-read { display: grid; justify-items: start; gap: 8px; }
.agent-tools-read > .copilotz-button { min-height: 0; padding: 0; }
.agent-edit { display: grid; gap: 14px; }
.agent-edit-card { padding: 20px; }
.agent-edit-end { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 10px;
  margin: 0 -24px -64px; padding: 14px 24px 18px; border-top: 1px solid var(--border);
  background: color-mix(in oklab, var(--background) 92%, transparent); backdrop-filter: blur(8px); }
.agent-edit-end .agent-form-note { flex: 1; min-width: 0; }
.agent-delete-means { display: grid; gap: 10px; margin: 0 0 4px; padding: 0 0 0 18px; color: var(--secondary-foreground);
  font-size: 14px; line-height: 1.5; }
.agent-delete-means b { color: var(--foreground); font-weight: 620; }
.agent-delete-means + .copilotz-notice { margin-top: 14px; }
.agent-missing { display: grid; place-items: center; height: 100%; padding: 32px; }
@container copilotz-page (max-width: 560px) {
  .agent-edit-card { padding: 16px; }
  .agent-edit-end { flex-wrap: wrap; margin: 0 -16px -48px; padding: 12px 16px 14px; }
  .agent-edit-end .agent-form-note { flex-basis: 100%; }
  .agent-edit-end .copilotz-button { flex: 1; }
  .agent-form-who { gap: 12px; }
  .agent-form-who > .copilotz-avatar { --size: 44px !important; margin-top: 24px; }
  .agent-face-empty { width: 44px; height: 44px; margin-top: 24px; }
}
@container agent-add (max-width: 420px) {
  .agent-form-who { gap: 12px; }
  .agent-form-who > .copilotz-avatar { --size: 44px !important; margin-top: 24px; }
  .agent-face-empty { width: 44px; height: 44px; margin-top: 24px; }
  .agent-new-top { flex-wrap: wrap; }
  .agent-new-end { flex-wrap: wrap; }
  .agent-new-end .agent-form-note { flex-basis: 100%; }
  .agent-new-end .agent-form-note:empty { display: none; }
  .agent-new-end .copilotz-button { flex: 1; }
}
`;
