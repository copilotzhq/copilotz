/**
 * Computers' layout on the web, on the theme's variables: a computer's mark,
 * connecting one, a space's computers (its tab), a computer's page (its
 * header, the space and tabs, the terminal, jobs and files, and uploading to
 * them), what an agent asks to do on one (inside chat's card for it), their
 * calls there, and Your AI's plans and computers (a card per plan, their
 * order, the connect flow's checklist, the welcome's step). Only layout: the
 * pieces are the toolkit's.
 */
export const STYLE = `
/* A computer's mark */
.computer-mark { position: relative; display: grid; place-items: center; flex: none; width: 22px; height: 22px;
  border-radius: var(--radius-sm); background: var(--muted); color: var(--secondary-foreground); }
.computer-mark-lg { width: 44px; height: 44px; border-radius: var(--radius-lg); background: var(--primary-soft);
  color: var(--primary-text); }
.computer-dot { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px; border-radius: var(--radius-full);
  background: var(--muted-foreground); outline: 2px solid var(--sidebar); opacity: .7; }
.computer-mark-lg .computer-dot { right: -3px; bottom: -3px; width: 13px; height: 13px; outline: 3px solid var(--background); }
.computer-mark[data-online] .computer-dot { background: var(--success); opacity: 1; }

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

/* Adding one: the ways, as a choice */
.add-body { display: grid; gap: 20px; }
.add-choices { list-style: none; display: grid; gap: 10px; margin: 0; padding: 0; }
.add-choice { display: grid; grid-template-columns: 44px minmax(0, 1fr) 16px; align-items: center; gap: 14px; width: 100%;
  padding: 14px 16px 14px 14px; color: inherit; font: inherit; }
.add-choice:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.add-choice-icon { display: grid; place-items: center; width: 44px; height: 44px; border-radius: var(--radius-lg);
  background: var(--muted); color: var(--secondary-foreground); }
.add-choice-icon[data-kind] { background: var(--primary-soft); color: var(--primary-text); }
.add-choice-text { display: grid; gap: 3px; min-width: 0; }
.add-choice-title { font-size: 15px; font-weight: 640; }
.add-choice-description { color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
.add-choice[data-blocked] { cursor: default; background: var(--muted); box-shadow: none; }
.add-choice[data-blocked] .add-choice-icon { opacity: 0.6; }
.add-choice-why { display: flex; align-items: flex-start; gap: 6px; }
.add-choice-why svg { flex: none; margin-top: 2px; }
.add-choice-go { color: var(--muted-foreground); transition: transform .15s, color .15s; }
.add-choice:hover .add-choice-go { color: var(--foreground); transform: translateX(2px); }
.add-yours { display: grid; gap: 8px; }
.add-yours h3 { margin: 0; color: var(--muted-foreground); font-size: 12px; font-weight: 650; letter-spacing: .06em;
  text-transform: uppercase; }
.add-yours ul { list-style: none; display: grid; gap: 2px; margin: 0; padding: 0; }
.add-yours-item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 6px 10px;
  border: 0; border-radius: var(--radius-md); background: transparent; color: inherit; font: inherit; text-align: left;
  cursor: pointer; }
.add-yours-item:hover { background: var(--accent); color: var(--accent-foreground); }
.add-yours-item:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.add-yours-item .computer-dot { outline-color: var(--popover); }
.add-yours-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 560; }
.add-yours-state { color: var(--muted-foreground); font-size: 12.5px; }
.add-yours-plus { color: var(--muted-foreground); }
.add-back { margin-right: auto; }
.desks-none-choices { max-width: 560px; }
.desks-none-choices .add-choices { width: 100%; margin-top: 10px; text-align: left; }
.desks-none-choices .desks-none-actions { margin-top: 2px; }
.add-choices-compact .add-choice { grid-template-columns: 36px minmax(0, 1fr) 14px; gap: 10px; padding: 10px 12px 10px 10px; }
.add-choices-compact .add-choice-icon { width: 36px; height: 36px; }

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
.jobs-start { display: grid; grid-template-columns: minmax(0, 1fr) minmax(120px, 200px) 92px auto; gap: 8px; }
.jobs-command input { font-family: var(--font-mono); font-size: 13.5px; }
.jobs-port input { font-variant-numeric: tabular-nums; }
.jobs-keep { grid-column: 1 / -1; margin: 2px 2px 0; font-size: 13.5px; }
.jobs-keep-hint { color: var(--muted-foreground); }
.jobs-more { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
  gap: 4px 16px; }
.jobs-more .jobs-keep { margin-top: 0; }
.jobs-env-toggle[aria-expanded=true] { color: var(--primary-text); }
.jobs-env { grid-column: 1 / -1; display: grid; gap: 6px; }
.jobs-env textarea { font-family: var(--font-mono); font-size: 13px; }
.jobs-env-hint { margin: 0 2px; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.jobs-env-hint code { font-size: 12px; }
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

/* What a job serves: its port, its preview, what else it can become */
.job-serve { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px;
  margin: 0 12px 12px 52px; padding: 8px 8px 8px 12px; border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 70%, var(--card)); font-size: 13px; }
.job-serve-what { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-width: 0;
  color: var(--secondary-foreground); }
.job-serve-what code { font-size: 12.5px; font-weight: 600; color: var(--foreground); }
.job-serve-dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--success); }
.job-serve-url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--primary-text);
  font-weight: 560; text-decoration: none; }
.job-serve-url:hover { text-decoration: underline; text-underline-offset: 3px; }
.job-serve-actions { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.job-serve-split { display: inline-flex; }
.job-serve-split > .copilotz-button { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.job-serve-split .copilotz-icon-button { width: 28px; height: 30px; margin-left: -1px; border-top-left-radius: 0;
  border-bottom-left-radius: 0; }
.job-serve-error { flex-basis: 100%; }
.serve-who { display: inline-flex; align-items: center; gap: 5px; color: var(--muted-foreground); font-size: 12.5px;
  white-space: nowrap; }
.serve-who[data-visibility=link] { color: var(--warning-text); }

/* Previews */
.preview-row { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  padding: 10px 10px 10px 14px; }
.preview[aria-busy] { opacity: .65; }
.preview-icon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.preview-icon[data-visibility=link] { background: var(--warning-soft); color: var(--warning-text); }
.preview-text { display: grid; gap: 2px; min-width: 0; }
.preview-url { display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--primary-text);
  font-weight: 600; font-size: 14px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
a.preview-url:hover { text-decoration: underline; text-underline-offset: 3px; }
.preview-meta { display: flex; flex-wrap: wrap; gap: 2px 10px; margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.preview-meta code { font-size: 12px; }
.preview-meta .copilotz-time { font-size: 12.5px; }
.preview-job { min-width: 0; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preview-actions { display: flex; align-items: center; gap: 4px; }
.preview-error { margin: 0 14px 10px 56px; }
@container computer-work (max-width: 560px) {
  .jobs-start { grid-template-columns: minmax(0, 1fr) 84px auto; }
  .jobs-start .jobs-command { grid-column: 1 / -1; }
  .job-row { grid-template-columns: 26px minmax(0, 1fr); }
  .job-actions { grid-column: 2; }
  .job-serve { margin-left: 12px; }
  .preview-row { grid-template-columns: 30px minmax(0, 1fr); }
  .preview-actions { grid-column: 2; }
  .preview-error { margin-left: 14px; }
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
.files-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 6px; }
.files-filter { width: 170px; }
.files-glyph { flex: none; display: inline-block; vertical-align: middle; }
.files-new { max-width: 420px; }
.files-view-only { display: flex; align-items: flex-start; gap: 7px; margin: -2px 0 0; color: var(--muted-foreground);
  font-size: 13px; line-height: 1.45; }
.files-view-only > .copilotz-icon { margin-top: 2px; }
.files-body { position: relative; display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-items: start; }
.files[data-over] .files-body { min-height: 190px; }

/* Where files dragged over the tab go: over the listing, only while they're dragged */
.files-drop { position: absolute; inset: 0; z-index: 3; display: grid; place-content: center; justify-items: center; gap: 6px;
  padding: 24px; border: 2px dashed var(--primary); border-radius: var(--radius-xl);
  background: color-mix(in oklab, var(--primary-soft) 80%, var(--card)); color: var(--primary-text); text-align: center;
  pointer-events: none; animation: files-drop-in .14s ease-out; }
.files-drop strong { font-size: 15px; font-weight: 650; }
.files-drop-to { max-width: 100%; color: var(--secondary-foreground); font-size: 13px; overflow-wrap: anywhere; }
.files-drop-mark { display: grid; place-items: center; width: 46px; height: 46px; margin-bottom: 2px;
  border-radius: var(--radius-full); background: var(--card); color: var(--primary-text); box-shadow: var(--shadow-sm); }
@keyframes files-drop-in { from { opacity: 0; transform: scale(.985); } }

/* Uploads: the batch's line and progress, then a row a file */
.uploads { display: grid; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--card);
  overflow: hidden; }
.uploads-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 42px; padding: 5px 6px 5px 12px; }
.uploads-mark { display: grid; place-items: center; color: var(--success-text); }
.uploads[data-going] .uploads-mark { color: var(--primary-text); }
.uploads[data-failed]:not([data-going]) .uploads-mark { color: var(--destructive-text); }
.uploads-title { margin: 0; font-size: 13.5px; font-weight: 620; }
.uploads-left { color: var(--muted-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.uploads-actions { display: flex; align-items: center; gap: 4px; margin-left: auto; }
.uploads-bar { display: block; height: 2px; background: var(--muted); }
.uploads-bar > span, .upload-bar > span { display: block; height: 100%; border-radius: inherit; background: var(--primary);
  transition: width .25s ease-out; }
.uploads-list { list-style: none; display: grid; max-height: 244px; margin: 0; padding: 4px; overflow: auto;
  border-top: 1px solid var(--border); }
.upload { position: relative; display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  min-height: 46px; padding: 5px 6px 7px 8px; border-radius: var(--radius-md); }
.upload-icon { display: grid; place-items: center; color: var(--muted-foreground); }
.upload[data-state=sending] .upload-icon { color: var(--primary-text); }
.upload[data-state=done] .upload-icon { color: var(--success-text); }
.upload[data-state=failed] .upload-icon { color: var(--destructive-text); }
.upload[data-state=asking] .upload-icon { color: var(--warning-text); }
.upload-text { display: grid; min-width: 0; }
.upload-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 560; }
.upload-open { justify-self: start; max-width: 100%; padding: 0; border: 0; background: transparent; color: inherit;
  font-family: inherit; text-align: left; cursor: pointer; }
.upload-open:hover, .upload-open:focus-visible { color: var(--primary-text); text-decoration: underline; text-underline-offset: 3px; }
.upload[data-state=cancelled] .upload-name, .upload[data-state=skipped] .upload-name { color: var(--muted-foreground); }
.upload-meta { color: var(--muted-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.upload-meta[data-tone=bad] { color: var(--destructive-text); }
.upload-end { display: flex; align-items: center; }
.upload-bar { position: absolute; left: 42px; right: 12px; bottom: 4px; height: 3px; border-radius: var(--radius-full);
  background: var(--muted); overflow: hidden; }
.upload-bar[data-waiting] > span { width: 34% !important; animation: upload-wait 1.3s ease-in-out infinite alternate; }
@keyframes upload-wait { from { transform: translateX(-100%); } to { transform: translateX(295%); } }
@media (prefers-reduced-motion: reduce) {
  .upload-bar[data-waiting] > span { width: 100% !important; opacity: .45; animation: none; }
  .files-drop { animation: none; }
}

/* A name that's taken: the question */
.upload-ask { display: grid; gap: 12px; font-size: 14px; line-height: 1.5; }
.upload-ask p { margin: 0; overflow-wrap: anywhere; }
.upload-ask-sides { list-style: none; display: grid; gap: 6px; margin: 0; padding: 10px 12px; border-radius: var(--radius-lg);
  background: var(--muted); color: var(--secondary-foreground); font-size: 13px; }
.upload-ask-sides li { display: flex; align-items: center; gap: 8px; }
.upload-ask-sides li > :first-child { flex: none; color: var(--muted-foreground); }
.upload-ask .upload-ask-keep { color: var(--muted-foreground); font-size: 13px; }
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
.file-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-name > .copilotz-badge { flex: none; }
.file-row[data-fresh]:not([data-current]) { background: color-mix(in oklab, var(--success-soft) 75%, transparent); }
.file-row[data-fresh]:not([data-current]):hover { background: var(--success-soft); }
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

/* What you've let agents do: on the Computer tab */
.computer-allowed { display: grid; gap: 10px; margin-top: 14px; }
.computer-allowed h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; font-weight: 650; }
.computer-allowed h3 .copilotz-icon { color: var(--muted-foreground); }
.computer-allowed ul { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.computer-allowed li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; font-size: 13.5px; }
.computer-allowed li + li { border-top: 1px solid var(--border); }
.computer-allowed li span { display: grid; gap: 2px; min-width: 0; }
.computer-allowed small { color: var(--muted-foreground); font-size: 12.5px; }
.computer-allowed .ask-error, .routine-allowed .ask-error { margin: 0; color: var(--destructive-text); font-size: 13px; }
/* What a routine may do on its own: on its page */
.routine-allowed-wrap { display: grid; gap: 12px; }
.routine-allowed-wrap:empty { display: none; }
.routine-allowed { display: grid; gap: 12px; }
.routine-allowed h2 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 15px; font-weight: 650; }
.routine-allowed h2 .copilotz-icon { color: var(--muted-foreground); }
.routine-allowed-note { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.routine-allowed-row { display: grid; gap: 8px; min-width: 0; margin: 0; padding: 12px 0 0; border: 0; border-top: 1px solid var(--border); }
.routine-allowed-row legend { display: contents; font-size: 14px; font-weight: 600; }
.routine-allowed-row legend small { margin-left: 8px; color: var(--muted-foreground); font-size: 12.5px; font-weight: 500; }
.routine-allowed-work { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.routine-allowed-what { overflow-wrap: anywhere; font-size: 13px; }
/* What an agent asks to do on one, inside chat's card for it (chat draws the card and its answers) */
.ask-what .copilotz-code-body { padding: 7px 11px; font-size: 13px; }
.ask-preview .copilotz-code-head code { font-size: 12.5px; font-weight: 600; }
.ask-publish { display: grid; gap: 4px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); }
.ask-publish-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin: 0; font-size: 14.5px; }
.ask-publish-at { color: var(--primary-text); font-size: 13px; overflow-wrap: anywhere; }
.ask-publish-from { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }

/* Agents' calls, in the conversation */
.step-computer { min-width: 0; }
.step-on { display: inline-flex; align-items: center; gap: 5px; margin: 0 0 6px; padding: 2px 8px;
  border-radius: var(--radius-sm); background: var(--muted); color: var(--muted-foreground); font-size: 12px; }
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
.step-search, .step-moved { display: grid; gap: 8px; }
.step-moved .step-line-text code { font-size: 12.5px; overflow-wrap: anywhere; }
.step-moved .step-line-text a { color: var(--primary-text); font-weight: 600; text-underline-offset: 3px; }
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

/* A space's environment (its tab) */
.env { container: env / inline-size; display: grid; gap: 14px; }
.env-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 18px; }
.env-intro { flex: 1 1 320px; max-width: 720px; margin: 0 2px; color: var(--muted-foreground); font-size: 13.5px;
  line-height: 1.5; }
.env-intro strong { color: var(--foreground); font-weight: 620; }
.env-table { overflow: hidden; }
.env-list { list-style: none; margin: 0; padding: 0; }
.env-row { display: grid; grid-template-columns: minmax(150px, 240px) minmax(0, 1fr) auto auto;
  grid-template-areas: "key value where actions"; align-items: center; gap: 6px 16px; min-height: 56px;
  padding: 9px 10px 9px 16px; transition: background-color .12s; }
.env-row + .env-row { border-top: 1px solid var(--border); }
.env-row:hover { background: color-mix(in oklab, var(--muted) 40%, var(--card)); }
.env-key { grid-area: key; display: grid; gap: 1px; min-width: 0; }
.env-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--foreground);
  font-size: 13px; font-weight: 650; }
.env-meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted-foreground);
  font-size: 12px; }
.env-meta .copilotz-time { font-size: 12px; }
.env-value { grid-area: value; display: flex; align-items: center; gap: 2px; min-width: 0; }
.env-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--secondary-foreground);
  font-size: 12.5px; }
.env-sealed { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 7px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--muted-foreground); font: 12px var(--font-mono); letter-spacing: .04em; }
.env-blank { color: var(--muted-foreground); font-size: 12.5px; font-style: italic; }
.env-where { grid-area: where; display: inline-flex; align-items: center; gap: 5px; color: var(--muted-foreground);
  font-size: 12.5px; white-space: nowrap; }
.env-where[data-exposed] { color: var(--warning-text); }
.env-actions { grid-area: actions; display: flex; align-items: center; gap: 2px; }
.env-empty { margin-top: 12px; }
.env-dialog-text { margin: 0 0 12px; line-height: 1.55; }
.env-form { display: grid; gap: 16px; }
.env-form-name input, .env-form-value { font-family: var(--font-mono); font-size: 13.5px; }
.env-form-options { display: grid; gap: 12px; padding: 12px 14px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: color-mix(in oklab, var(--muted) 40%, var(--popover)); }
.env-form-options .copilotz-checkbox > span { display: grid; gap: 1px; }
.env-form-option { font-size: 14px; font-weight: 580; }
.env-form-option-note { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.env-form-limit { margin-top: -4px; }
@container env (max-width: 600px) {
  .env-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "key actions" "value value" "where where";
    padding-left: 14px; }
}

/* Plans on the person's computers (Connected accounts) */
.plans { display: grid; gap: 12px; margin-top: 22px; }
.plans-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 8px 16px;
  padding: 0 2px; }
.plans-titles { flex: 1 1 340px; min-width: 0; }
.plans-titles h2 { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 650; letter-spacing: -.01em;
  line-height: 1.3; }
.plans-titles p { max-width: 74ch; margin: 4px 0 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.plans-tools { display: flex; flex-wrap: wrap; gap: 2px; margin-right: -6px; color: var(--muted-foreground); }
.plans-list { list-style: none; display: grid; gap: 12px; margin: 0; padding: 0; }
.plans-foot { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 8px; margin: 2px 2px 0;
  color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.plans-foot > .copilotz-icon { flex: none; margin-top: 2px; }
.plans-foot > span { flex: 1 1 300px; }

.plan { overflow: hidden; }
.plan-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 14px;
  padding: 18px 18px 16px; }
.plan-mark { display: grid; place-items: center; width: 42px; height: 42px; border-radius: var(--radius-lg);
  background: var(--primary-soft); color: var(--primary-text); }
.plan-titles { min-width: 0; }
.plan-title { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0;
  font-family: var(--font-display); font-size: 16.5px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; }
.plan-about { margin: 3px 0 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.plan-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.plan-actions:empty { display: none; }
.plan-install { grid-column: 2 / -1; display: grid; gap: 8px; margin: 6px 0 4px; }
.plan-install > p { margin: 0; color: var(--secondary-foreground); font-size: 13.5px; }
.plan-install-command .copilotz-code-body { padding-block: 9px; font-size: 13px; }
.plan-install-then { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px;
  color: var(--muted-foreground); font-size: 13px; }
@container copilotz-page (max-width: 560px) {
  .plan-head { grid-template-columns: auto minmax(0, 1fr); padding: 16px 16px 14px; }
  .plan-actions { grid-column: 1 / -1; justify-content: flex-start; margin-top: 10px; }
}

/* A computer shared with others' agents: why, and how to change it */
.plan-shared { display: grid; gap: 10px; }
.plan-shared > p { margin: 0; line-height: 1.55; }
.plan-shared-spaces { list-style: none; display: grid; gap: 6px; margin: 2px 0 0; padding: 0; }
.plan-shared-spaces a { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); color: var(--foreground); font-size: 13.5px; font-weight: 560; text-decoration: none;
  transition: background-color .15s, border-color .15s; }
.plan-shared-spaces a:hover { background: var(--accent); border-color: color-mix(in oklab, var(--border) 60%, var(--ring)); }
.plan-shared-spaces a > span { flex: 1; min-width: 0; }
.plan-shared-spaces a > .copilotz-icon { flex: none; color: var(--muted-foreground); }

/* Signing a plan in */

.plan-quiet { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.plan-open { justify-self: start; }
.plan-shown-code { display: inline-flex; align-items: center; gap: 8px; justify-self: start; padding: 6px 8px 6px 14px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--muted); }
.plan-shown-code code { font: 600 18px var(--font-mono); letter-spacing: .12em; }
.plan-code { display: grid; min-width: 0; }
.plan-code input { font-family: var(--font-mono); }
.plan-output { border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
.plan-output > summary { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 8px 12px; cursor: pointer;
  list-style: none; color: var(--secondary-foreground); font-size: 13px; border-radius: var(--radius-lg); }
.plan-output > summary::-webkit-details-marker { display: none; }
.plan-output > summary:hover { color: var(--foreground); }
.plan-output > .plan-output-code { margin: 0 10px 10px; }
.plan-output-code .copilotz-code-body { font-size: 12px; }
/* Your plans: a card's state, the order; Your computers; the connect flow */
.plan-about[data-tone=success] { color: var(--success-text); }
.plan-about[data-tone=warning] { color: var(--warning-text); }
.plans-order { display: grid; gap: 8px; margin-top: 6px; }
.plans-order h3 { margin: 0; font-size: 15px; font-weight: 650; }
.plans-order-list { list-style: none; display: grid; gap: 6px; margin: 0; padding: 0; }
.plans-order-list li { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto auto; align-items: center; gap: 8px;
  padding: 6px 8px 6px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
.plans-order-n { color: var(--muted-foreground); font-size: 13px; font-variant-numeric: tabular-nums; }
.plans-order-name { min-width: 0; overflow-wrap: anywhere; font-size: 14px; font-weight: 560; }
.plans-order-up { transform: rotate(180deg); }
.yours-list { list-style: none; display: grid; margin: 0; padding: 0; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); }
.yours-computer { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 4px 12px;
  padding: 12px 14px; }
.yours-computer + .yours-computer { border-top: 1px solid var(--border); }
.yours-computer .computer-mark { width: 30px; height: 30px; border-radius: var(--radius-md); }
.yours-text { display: grid; gap: 2px; min-width: 0; }
.yours-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.yours-state { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 4px; color: var(--muted-foreground);
  font-size: 13px; }
.yours-actions { display: flex; align-items: center; gap: 4px; }
@media (max-width: 560px) {
  .yours-computer { grid-template-columns: auto minmax(0, 1fr); }
  .yours-actions { grid-column: 2; }
}
.flow { display: grid; gap: 14px; }
.flow-over { margin: 0; padding: 10px 14px; border-radius: var(--radius-lg); background: var(--success-soft);
  color: var(--success-text); line-height: 1.5; }
.flow-lines { list-style: none; display: grid; gap: 14px; margin: 0; padding: 0; }
.flow-line { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; }
.flow-line-mark { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--secondary-foreground); }
.flow-line[data-state=active] .flow-line-mark { background: var(--primary-soft); color: var(--primary-text); }
.flow-line[data-state=done] .flow-line-mark { background: var(--success-soft); color: var(--success-text); }
.flow-line[data-state=failed] .flow-line-mark { background: var(--warning-soft); color: var(--warning-text); }
.flow-line[data-state=waiting] { opacity: .62; }
.flow-line-body { display: grid; gap: 8px; min-width: 0; padding-top: 3px; }
.flow-line-title { margin: 0; font-weight: 600; line-height: 1.45; }
.flow-line[data-state=done] .flow-line-title { color: var(--muted-foreground); font-weight: 500; }
.flow-line-body > .plan-quiet { margin-top: -4px; }
.flow-signin, .flow-failed { display: grid; gap: 10px; min-width: 0; }
.flow-signin > p { margin: 0; line-height: 1.55; }
.flow-failed .plan-install { grid-column: auto; margin: 0; }
.flow-picks { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.flow-pick { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); }
.flow-pick-text { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-weight: 560; }
.flow-where { display: grid; gap: 10px; }
.flow-choice .add-choice-title { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.flow-welcome { display: grid; gap: 12px; }
.flow-welcome-go { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
`;
