/**
 * Computers' layout on the web, on the theme's variables: what waits on you
 * (in the sidebar), connecting one, a space's computers (its tab), a
 * computer's page (its header, the space and tabs, the terminal, jobs and
 * files), what agents ask in a chat, and their calls there. Only layout:
 * the pieces are the toolkit's.
 */
export const STYLE = `
/* The sidebar: what waits on you */
.computers { list-style: none; display: grid; gap: 1px; margin: 0; padding: 0; }
.computer-mark { position: relative; display: grid; place-items: center; flex: none; width: 22px; height: 22px;
  border-radius: var(--radius-sm); background: var(--muted); color: var(--secondary-foreground); }
.computer-mark-lg { width: 44px; height: 44px; border-radius: var(--radius-lg); background: var(--primary-soft);
  color: var(--primary-text); }
.computer-dot { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border-radius: var(--radius-full);
  background: var(--muted-foreground); outline: 2px solid var(--sidebar); opacity: .7; }
.computer-mark-lg .computer-dot { right: -3px; bottom: -3px; width: 13px; height: 13px; outline: 3px solid var(--background); }
.computer-mark[data-online] .computer-dot { background: var(--success); opacity: 1; }
.computers-waiting { display: grid; place-items: center; flex: none; width: 22px; height: 22px;
  border-radius: var(--radius-full); background: var(--warning-soft); color: var(--warning-text);
  animation: computers-pulse 2.4s ease-in-out infinite; }
@keyframes computers-pulse { 50% { background: color-mix(in oklab, var(--warning) 26%, var(--sidebar)); } }
.computers-more { margin: 0 10px 4px 41px; color: var(--muted-foreground); font-size: 12px; }

/* Connecting one */
.connect-notice { margin-bottom: 18px; }
.connect-steps { list-style: none; display: grid; gap: 18px; margin: 4px 0 0; padding: 0; }
.connect-steps > li:not(.connect-waiting) { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; }
.connect-step-number { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--primary-soft); color: var(--primary-text); font-size: 13px; font-weight: 700; }
.connect-step { display: grid; gap: 10px; min-width: 0; padding-top: 2px; }
.connect-step p { margin: 0; line-height: 1.55; }
.connect-step code { font-size: .92em; }
.connect-command .copilotz-code-body { padding-block: 10px; font-size: 13px; }
.connect-expiry { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--muted-foreground);
  font-size: 13px; }
.connect-left { color: var(--foreground); font-variant-numeric: tabular-nums; }
.connect-waiting { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: var(--radius-lg);
  background: var(--muted); color: var(--secondary-foreground); font-size: 13.5px; }
.connect-done { display: flex; align-items: center; gap: 14px; padding: 6px 0 4px; }
.connect-done-icon { display: grid; place-items: center; flex: none; width: 46px; height: 46px; border-radius: var(--radius-full);
  background: var(--success-soft); color: var(--success-text); }
.connect-done-name { margin: 0; font-size: 16px; font-weight: 650; }
.connect-done-facts { margin: 2px 0 0; color: var(--muted-foreground); font-size: 13.5px; }
.connect-step-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.connect-step .connect-step-title { font-weight: 620; }
.connect-systems { flex: none; }
.connect-systems .copilotz-tab { height: 28px; padding: 0 10px; font-size: 13px; }
.connect-direct { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
.connect-direct > summary { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; white-space: nowrap;
  list-style: none; color: var(--secondary-foreground); font-size: 13.5px; font-weight: 560; border-radius: var(--radius-lg); }
.connect-direct > summary::-webkit-details-marker { display: none; }
.connect-direct > summary:hover { color: var(--foreground); }
.connect-direct-chevron { transition: transform .15s; color: var(--muted-foreground); }
.connect-direct[open] .connect-direct-chevron { transform: rotate(90deg); }
.connect-direct-version { margin-left: auto; color: var(--muted-foreground); font-size: 12.5px; font-weight: 450;
  font-variant-numeric: tabular-nums; }
.connect-direct-body { display: grid; gap: 10px; padding: 2px 12px 12px; }
.connect-direct-body > p { font-size: 13.5px; }
.connect-binaries { list-style: none; display: grid; gap: 1px; margin: 0; padding: 0; border-radius: var(--radius-md);
  overflow: hidden; background: var(--border); }
.connect-binary { display: flex; align-items: center; gap: 12px; padding: 10px 12px; background: var(--card); }
.connect-binary-text { display: grid; gap: 2px; flex: 1; min-width: 0; }
.connect-binary-name { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 13.5px; }
.connect-binary-yours { padding: 1px 7px; border-radius: var(--radius-full); background: var(--primary-soft);
  color: var(--primary-text); font-size: 11.5px; font-weight: 600; }
.connect-binary-facts, .connect-binary-sha { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px;
  color: var(--muted-foreground); font-size: 12.5px; min-width: 0; }
.connect-binary-facts code, .connect-binary-sha code { font-size: 12px; overflow-wrap: anywhere; }
.connect-binary-sha .copilotz-copy { height: 22px; padding: 0 5px; }
.connect-unsigned, .connect-stop { display: flex; align-items: flex-start; gap: 8px; margin: 0;
  color: var(--muted-foreground); font-size: 12.5px; line-height: 1.5; }
.connect-unsigned svg, .connect-stop svg { flex: none; margin-top: 2px; }
.connect-stop { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 13px; }
.connect-stop code, .connect-unsigned code { font-size: .92em; }
@media (max-width: 560px) {
  .connect-binary { flex-wrap: wrap; }
  .connect-binary .copilotz-button { width: 100%; justify-content: center; }
}

/* A space's computers: its tab */
.space-computers { display: grid; gap: 16px; }
.desks { display: grid; gap: 10px; }
.desks-list { list-style: none; display: flex; flex-wrap: wrap; align-items: stretch; gap: 8px; margin: 0; padding: 0; }
.desk { display: flex; align-items: center; min-width: 0; max-width: 100%; padding: 0 4px 0 0;
  transition: border-color .15s, background-color .15s; }
.desk[data-chosen] { border-color: var(--primary-border); background: var(--primary-soft); }
.desk-pick { display: flex; align-items: center; gap: 11px; min-width: 0; padding: 9px 8px 9px 12px; border: 0;
  background: transparent; color: inherit; font: inherit; text-align: left; }
button.desk-pick { cursor: pointer; }
.desk .computer-mark { width: 32px; height: 32px; border-radius: var(--radius-md); }
.desk .computer-dot { outline-color: var(--card); }
.desk[data-chosen] .computer-mark { background: var(--card); color: var(--primary-text); }
.desk-text { display: grid; gap: 1px; min-width: 0; }
.desk-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 620; }
.desk-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desk-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; color: var(--muted-foreground);
  font-size: 12.5px; }
.desk-meta .copilotz-time { font-size: 12.5px; }
.desk-online { color: var(--success-text); }
.desks-add { display: flex; align-items: center; }
.desks-notes { display: grid; gap: 4px; }
.desks-note { display: flex; align-items: baseline; gap: 7px; margin: 0 2px; color: var(--muted-foreground);
  font-size: 12.5px; line-height: 1.5; }
.desks-note .copilotz-icon { flex: none; transform: translateY(2px); }
.desks-none { display: grid; justify-items: center; gap: 8px; max-width: 520px; margin: 28px auto 8px;
  text-align: center; }
.desks-none-icon { display: grid; place-items: center; width: 56px; height: 56px; margin-bottom: 8px;
  border-radius: var(--radius-2xl); background: var(--primary-soft); color: var(--primary-text); }
.desks-none h3 { margin: 0; font-family: var(--font-display); font-size: 19px; font-weight: 650; letter-spacing: -.015em; }
.desks-none p { margin: 0; color: var(--muted-foreground); line-height: 1.55; }
.desks-none-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 10px; }
.desks-dialog { display: grid; gap: 14px; }
.desks-dialog-hint, .desks-dialog-text { margin: 0; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.55; }
.desks-dialog-hint { padding-left: 28px; margin-top: -8px; }
.desks-dialog-text { color: inherit; font-size: 14px; }
.desks-compact .desks-list { flex-direction: column; flex-wrap: nowrap; }
.desks-compact .desk { width: 100%; }
.desks-compact .desk-pick { flex: 1; }
.desks-compact .desks-add { align-self: flex-start; }
.desks-compact .desks-none { margin-top: 12px; }
.desks-compact .desks-none h3 { font-size: 16px; }
.desks-compact .desks-none p { font-size: 13.5px; }
.space-computers .computer-terminal-screen { height: clamp(300px, calc(100dvh - 450px), 760px); }
.space-computers-compact { gap: 12px; }
.computer-work-compact { margin-top: 0; }
.computer-work-compact .computer-terminal-screen { height: clamp(260px, calc(100dvh - 330px), 720px); }
.computer-work-compact .computer-panel { padding-top: 12px; }
.computer-work-compact .computer-bar .copilotz-tab { padding: 0 4px; }

/* A computer's page */
.computer-page { container: computer-page / inline-size; }
.computer-page .copilotz-page-description { max-width: none; }
.computer-loading { display: grid; gap: 18px; margin-top: 8px; }
.computer-gone { display: grid; place-items: center; padding: 32px; }
.computer-presence { gap: 6px; }
.computer-presence-dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: currentColor; }
.computer-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; font-size: 13.5px; }
.computer-facts > span { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.computer-facts code { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.computer-rename { display: block; max-width: 420px; }
.computer-forget-text { margin: 0 0 12px; line-height: 1.55; }
.computer-forget-text code { font-size: .92em; }

.computer-work { container: computer-work / inline-size; margin-top: 4px; }
.computer-bar { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 10px 18px;
  border-bottom: 1px solid var(--border); }
.computer-bar .copilotz-tabs-line { border-bottom: 0; }
.computer-space { display: flex; align-items: center; gap: 8px; min-width: 0; padding-bottom: 6px; font-size: 13px; }
.computer-space-label { color: var(--muted-foreground); }
.computer-space-path { min-width: 0; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; }
.computer-space-path code { font-size: 12px; }
.computer-panel { padding-top: 16px; }
.computer-tab[hidden] { display: none; }
.computer-offline { display: grid; gap: 12px; max-width: 640px; }

/* The terminal */
.computer-terminal { display: grid; gap: 8px; }
.computer-terminal-screen { height: clamp(320px, calc(100dvh - 340px), 860px); }
.computer-terminal-hint { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin: 0 2px;
  color: var(--muted-foreground); font-size: 12.5px; }

/* Jobs */
.jobs { display: grid; gap: 18px; }
.jobs-start { display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 200px) auto; gap: 8px; }
.jobs-command input { font-family: var(--font-mono); font-size: 13.5px; }
.jobs-error { grid-column: 1 / -1; margin: 0; color: var(--destructive-text); font-size: 13px; }
.jobs-group { display: grid; gap: 8px; }
.jobs-group h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 12px; font-weight: 650;
  letter-spacing: .06em; text-transform: uppercase; color: var(--muted-foreground); }
.jobs-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }
.jobs-list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.job-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  padding: 11px 12px 11px 14px; }
.job-state { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--muted-foreground); }
.job-state[data-state=running] { background: var(--success-soft); }
.job-state[data-state=done] { background: var(--success-soft); color: var(--success-text); }
.job-state[data-state=failed] { background: var(--destructive-soft); color: var(--destructive-text); }
.job-pulse { width: 9px; height: 9px; border-radius: var(--radius-full); background: var(--success);
  animation: job-pulse 1.6s ease-in-out infinite; }
@keyframes job-pulse { 50% { transform: scale(.6); opacity: .5; } }
.job-text { display: grid; gap: 3px; min-width: 0; }
.job-name { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-weight: 620; }
.job-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-command { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--secondary-foreground);
  font-size: 12.5px; }
.job-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0; color: var(--muted-foreground);
  font-size: 12.5px; }
.job-meta .copilotz-time { font-size: 12.5px; }
.job-who { display: inline-flex; align-items: center; gap: 5px; color: var(--secondary-foreground); }
.job-actions { display: flex; align-items: center; gap: 4px; }
.job-error { margin: 0 14px 10px 52px; }
.job-logs { padding: 0 12px 12px; }
.job-streams { display: grid; gap: 8px; }
.job-loading { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--muted-foreground); font-size: 13px; }
.jobs-empty { margin-top: 18px; }
@container computer-work (max-width: 560px) {
  .jobs-start { grid-template-columns: minmax(0, 1fr) auto; }
  .jobs-start .jobs-command { grid-column: 1 / -1; }
  .job-row { grid-template-columns: 26px minmax(0, 1fr); }
  .job-actions { grid-column: 2; }
}

/* Files */
.files { display: grid; gap: 12px; }
.files-bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.files-crumbs { min-width: 0; }
.files-crumbs ol { list-style: none; display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 0; padding: 0; }
.files-crumbs li { display: inline-flex; align-items: center; gap: 2px; min-width: 0; }
.files-crumb { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; padding: 4px 8px;
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--secondary-foreground);
  font-size: 13.5px; font-weight: 560; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.files-crumb:hover { background: var(--accent); color: var(--accent-foreground); }
.files-crumb[aria-current] { color: var(--foreground); font-weight: 650; }
.files-crumb .copilotz-icon { color: var(--primary-text); }
.files-crumb-sep { color: var(--muted-foreground); }
.files-tools { display: flex; align-items: center; gap: 6px; }
.files-filter { width: 170px; }
.files-new { max-width: 420px; }
.files-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
.files[data-open] .files-body { grid-template-columns: minmax(210px, 300px) minmax(0, 1fr); }
.files-list-box { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--card);
  overflow: hidden; }
.files-list { list-style: none; display: grid; margin: 0; padding: 4px; }
.files-list > .copilotz-skeleton { margin: 3px 4px; }
.file-row { position: relative; display: flex; align-items: center; border-radius: var(--radius-md); }
.file-row:hover { background: var(--accent); }
.file-row[data-current] { background: var(--primary-soft); }
.file-open { flex: 1; min-width: 0; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center;
  gap: 10px; min-height: 38px; padding: 4px 8px; border: 0; border-radius: var(--radius-md); background: transparent;
  color: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.file-row:has(.file-save) .file-open { padding-right: 38px; }
.file-icon { display: grid; place-items: center; color: var(--muted-foreground); }
.file-icon[data-type=folder] { color: var(--primary-text); }
.file-icon[data-type=image] { color: var(--info-text); }
.file-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-meta { display: flex; align-items: center; gap: 10px; color: var(--muted-foreground); font-size: 12px;
  font-variant-numeric: tabular-nums; white-space: nowrap; }
.file-meta .copilotz-time { font-size: 12px; }
.file-size { min-width: 52px; text-align: right; }
.file-save { position: absolute; right: 5px; opacity: 0; transition: opacity .12s; }
.file-row:hover .file-save, .file-save:focus-visible, .file-save[aria-busy] { opacity: 1; }
@media (hover: none) { .file-save { opacity: 1; } }
.files[data-open] .file-meta { display: none; }
.files-empty { padding: 18px 8px; }
.files-none { padding: 14px 10px; color: var(--muted-foreground); font-size: 13.5px; }

.file-view { display: grid; gap: 10px; min-width: 0; }
.file-view-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.file-view-back { display: none; }
.file-view-title { flex: 1; min-width: 0; }
.file-view-title h3 { margin: 0; font-size: 15px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-view-title p { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 1px 0 0;
  color: var(--muted-foreground); font-size: 12.5px; }
.file-view-title .copilotz-time { font-size: 12.5px; }
.file-view-actions { flex: none; display: flex; align-items: center; gap: 6px; }
.file-view-body { min-width: 0; }
.file-view-wait { display: flex; align-items: center; gap: 8px; margin: 18px 4px; color: var(--muted-foreground); font-size: 13.5px; }
.file-text .copilotz-code-body { max-height: min(70vh, 760px); }
.file-lines { color: var(--muted-foreground); font: 500 12px var(--font-sans); }
.file-edit { width: 100%; min-height: min(62vh, 640px); font-family: var(--font-mono); font-size: 13px; line-height: 1.6;
  tab-size: 4; white-space: pre; }
.file-view-hint { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.file-picture { display: grid; gap: 8px; justify-items: center; margin: 0; padding: 18px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: repeating-conic-gradient(var(--muted) 0 25%, var(--card) 0 50%) 0 0 / 18px 18px; }
.file-picture img { display: block; max-width: 100%; max-height: min(66vh, 720px); object-fit: contain; }
@container computer-work (max-width: 680px) {
  .files[data-open] .files-body { grid-template-columns: minmax(0, 1fr); }
  .files[data-open] .files-list-box { display: none; }
  .file-view-back { display: inline-grid; }
  .file-view-close { display: none; }
  .files-filter { width: 130px; }
}

/* What agents ask, over where you type */
.asks { display: grid; gap: 8px; }
.asks > .ask { animation: ask-in .36s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes ask-in { from { opacity: 0; transform: translateY(8px); } }
.ask { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 12px 14px 12px 12px;
  border-color: var(--warning-border); box-shadow: var(--shadow-md); animation: ask-in .22s ease-out; }
@keyframes ask-in { from { opacity: 0; transform: translateY(6px); } }
.ask-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md);
  background: var(--warning-soft); color: var(--warning-text); }
.ask-main { display: grid; gap: 9px; min-width: 0; }
.ask-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; margin: 4px 0 0; font-size: 14.5px; }
.ask-where { margin-left: auto; color: var(--muted-foreground); font-size: 12.5px; }
.ask-where .copilotz-time { font-size: 12.5px; }
.ask-what .copilotz-code-body { padding: 7px 11px; font-size: 13px; }
.ask-preview .copilotz-code-head code { font-size: 12.5px; font-weight: 600; }
.ask-answers { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ask-deny { margin-left: auto; color: var(--destructive-text); }
.ask-error { margin: 0; color: var(--destructive-text); font-size: 13px; }
@media (max-width: 760px) {
  .ask { grid-template-columns: minmax(0, 1fr); padding: 12px; }
  .ask-icon { display: none; }
  .ask-head { margin: 0; }
  /* Two rows: Allow once and Deny, then the wider yeses (the tooltips' wrappers lay out as their buttons). */
  .ask-answers { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ask-answers .copilotz-button { order: 2; min-width: 0; width: 100%; white-space: normal; text-align: center;
    line-height: 1.2; }
  .ask-answers > :first-child .copilotz-button { order: 0; }
  .ask-answers > .ask-deny { order: 1; margin: 0; }
}

/* Agents' calls, in the conversation */
.step-computer { min-width: 0; }
.step-block .copilotz-code-head { font-weight: 560; }
.step-block .copilotz-code-title > span, .step-file { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 2px 6px;
  min-width: 0; font-family: var(--font-sans); font-size: 13px; }
.step-block .copilotz-code-title code { font-size: 12.5px; overflow-wrap: anywhere; }
.step-command { display: inline-flex; gap: 8px; min-width: 0; font-size: 12.5px; overflow-wrap: anywhere; white-space: pre-wrap; }
.step-prompt { color: var(--success-text); user-select: none; }
.step-status { display: inline-flex; align-items: center; gap: 6px; padding: 0 6px; color: var(--muted-foreground);
  font: 500 12px var(--font-sans); white-space: nowrap; }
.step-ok { display: inline-flex; align-items: center; gap: 3px; color: var(--success-text); }
.step-bad { color: var(--destructive-text); }
.step-block .copilotz-code-foot code { font-size: 11.5px; }
.step-line { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--secondary-foreground); font-size: 13.5px; }
.step-line > .copilotz-icon { color: var(--muted-foreground); }
.step-line-text { flex: 1; min-width: 0; }
.step-search { display: grid; gap: 8px; }
.step-results { list-style: none; display: grid; gap: 2px; margin: 0; padding: 0 0 0 22px; }
.step-results li { display: grid; padding: 6px 10px; border-left: 2px solid var(--border); }
.step-results a { display: inline-flex; align-items: center; gap: 5px; width: fit-content; color: var(--primary-text);
  font-weight: 600; font-size: 14px; text-decoration: none; }
.step-results a:hover { text-decoration: underline; text-underline-offset: 3px; }
.step-host { color: var(--success-text); font-size: 12px; }
.step-results p { margin: 2px 0 0; color: var(--secondary-foreground); font-size: 13px; line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.step-more { color: var(--muted-foreground); font-size: 12.5px; }
.step-why { margin: 0 0 0 22px; color: var(--muted-foreground); font-size: 13px; }
.step-page { margin: 0 0 0 22px; font-size: 13.5px; }
.step-page a { display: inline-flex; align-items: center; gap: 5px; color: var(--primary-text); }
`;
