/**
 * Documents' layout on the web, on the theme's variables only: the space's
 * list, a document's page (its title in place, the sticky toolbar, the
 * writing surface and the preview beside it, who's here), the conflict
 * screen, History's drawer, the reader beside a chat, and agents' cards.
 */
export const STYLE = `
.doc-page.copilotz-page-fill > .copilotz-page-inner { max-width: 1480px; }
.doc-page .copilotz-page-title { font-size: 32px; letter-spacing: -.03em; }
.doc-page .copilotz-page-head { align-items: start; }
.doc-page .copilotz-page-actions { padding-top: 3px; }
.doc-page .copilotz-page-description { max-width: none; margin-top: 10px; }
.doc-page .copilotz-page-body { margin-top: 16px; }

.doc-title-grow { display: grid; width: 100%; }
.doc-title-grow::after { content: attr(data-value); visibility: hidden; white-space: pre-wrap;
  overflow-wrap: anywhere; grid-area: 1 / 1 / 2 / 2; font: inherit; letter-spacing: inherit; }
.doc-title-input { grid-area: 1 / 1 / 2 / 2; width: 100%; min-width: 0; margin: 0; padding: 0; border: 0;
  background: transparent; color: inherit; font: inherit; letter-spacing: inherit; line-height: inherit;
  resize: none; overflow: hidden; outline: none; }
.doc-title-input::placeholder { color: var(--muted-foreground); opacity: .55; }

.doc-under { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; min-height: 22px; font-size: 13px; }
.doc-status { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; color: var(--muted-foreground); }
.doc-status[data-state=dirty], .doc-status[data-state=warning] { color: var(--warning-text); }
.doc-status[data-state=success] { color: var(--success-text); }
.doc-status[data-state=info] { color: var(--info-text); }
.doc-status[data-state=failed] { color: var(--destructive-text); }
.doc-status .copilotz-time { font-size: 13px; }
.doc-status-quiet { display: inline-flex; align-items: center; gap: 3px; color: var(--muted-foreground); }
.doc-status-quiet .copilotz-kbd { font-size: 11px; }
.doc-dot { width: 7px; height: 7px; border-radius: var(--radius-full); background: var(--warning); }
.doc-save { min-width: 76px; }
.doc-history-button { gap: 7px; }
.doc-glyph { flex: none; }
@container copilotz-page (max-width: 640px) {
  .doc-wide { display: none; }
  .doc-history-button { padding-inline: 9px; }
  .doc-page .copilotz-page-title { font-size: 24px; letter-spacing: -.02em; }
  .doc-status-quiet { display: none; }
}

.doc-here { display: inline-flex; align-items: center; padding-left: 6px; margin-right: 2px; }
.doc-here-face { position: relative; display: inline-flex; margin-left: -6px; border-radius: var(--radius-full);
  outline: 2px solid var(--background); }
.doc-here-face:focus-visible { outline-color: var(--ring); }
.doc-here-pen { position: absolute; right: -4px; bottom: -4px; display: grid; place-items: center; width: 15px;
  height: 15px; border-radius: var(--radius-full); background: var(--primary); color: var(--primary-foreground);
  outline: 2px solid var(--background); }
.doc-here-more { margin-left: 5px; color: var(--muted-foreground); font-size: 12px; font-weight: 600; }

.doc-body { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.doc-banner { margin-bottom: 14px; }
.doc-banner-actions { display: inline-flex; flex-wrap: wrap; gap: 6px; }

.doc-bar { position: sticky; top: 0; z-index: 3; margin: 0 -10px 20px; padding: 8px 10px;
  border-bottom: 1px solid var(--border); background: color-mix(in oklab, var(--background) 90%, transparent);
  backdrop-filter: saturate(1.4) blur(10px); -webkit-backdrop-filter: saturate(1.4) blur(10px); }
.doc-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.doc-tools { display: flex; flex: 1; min-width: 0; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; }
.doc-tools::-webkit-scrollbar { display: none; }
.doc-tool { display: inline-grid; flex: none; place-items: center; width: 32px; height: 32px; padding: 0; border: 0;
  border-radius: var(--radius-md); background: transparent; color: var(--muted-foreground); cursor: pointer;
  transition: background-color .12s, color .12s; }
.doc-tool:hover:not(:disabled), .doc-tool[aria-expanded=true] { background: var(--accent); color: var(--accent-foreground); }
.doc-tool:disabled { opacity: .35; cursor: default; }
.doc-tools-gap { flex: none; width: 1px; height: 18px; margin: 0 6px; background: var(--border); }
.doc-modes { flex: none; }
.doc-mode-toggle { flex: none; }
.doc-keys { display: inline-flex; gap: 2px; margin-left: 6px; vertical-align: middle; }
.doc-help { padding: 6px 8px 4px; }
.doc-help-title { margin: 0 0 8px; font-family: var(--font-display); font-weight: 650; }
.doc-help dl { display: grid; gap: 6px; margin: 0; }
.doc-help dl > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; }
.doc-help dd { margin: 0; }
.doc-help-note { margin: 10px 0 2px; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
@container copilotz-page (max-width: 640px) {
  .doc-bar { margin: 0 -16px 16px; padding: 6px 12px 6px max(12px, var(--copilotz-page-inset, 0px)); }
  .doc-toolbar { gap: 8px; }
  .doc-tool { width: 36px; height: 36px; }
}

.doc-surface { font: 400 16.5px/1.75 var(--font-sans); color: var(--foreground); min-width: 0; }
.doc-grow { display: grid; min-width: 0; }
.doc-grow::after { content: attr(data-value); visibility: hidden; white-space: pre-wrap; overflow-wrap: anywhere;
  grid-area: 1 / 1 / 2 / 2; font: inherit; tab-size: 4; min-height: 52vh; }
.doc-input.copilotz-textarea { grid-area: 1 / 1 / 2 / 2; min-height: 52vh; overflow: hidden; resize: none;
  font: inherit; line-height: inherit; color: inherit; tab-size: 4; caret-color: var(--primary-text);
  overflow-wrap: anywhere; }
.doc-input.copilotz-textarea::placeholder { color: var(--muted-foreground); opacity: .7; }
.doc-surface-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; }
.doc-surface-split .doc-grow { padding-right: 36px; }
.doc-surface-split .doc-preview { position: sticky; top: 62px; max-height: calc(100dvh - 86px); overflow: auto;
  padding: 0 4px 24px 36px; border-left: 1px solid var(--border); overscroll-behavior: contain;
  scrollbar-width: thin; scrollbar-color: var(--input) transparent; }
.doc-surface-preview .doc-preview { min-height: 40vh; padding-top: 10px; }
.doc-empty-preview { margin: 0; color: var(--muted-foreground); font-style: italic; }

.doc-md { font-size: 16.5px; line-height: 1.75; }
.doc-md :is(h3, h4, h5, h6) { font-family: var(--font-display); letter-spacing: -.02em; line-height: 1.25; }
.doc-md h3 { margin: 1.5em 0 .5em; font-size: 1.75em; font-weight: 700; }
.doc-md h4 { margin: 1.5em 0 .45em; font-size: 1.32em; font-weight: 660; }
.doc-md h5 { margin: 1.3em 0 .4em; font-size: 1.1em; font-weight: 650; }
.doc-md > :is(p, ul, ol, blockquote) { margin-bottom: .95em; }
.doc-md > :first-child { margin-top: 0; }
.doc-md-small { font-size: 14.5px; line-height: 1.65; }
.doc-md-small h3 { font-size: 1.45em; }
.doc-md-small h4 { font-size: 1.2em; }

.doc-foot { display: flex; flex-wrap: wrap; gap: 4px 18px; margin-top: 28px; padding-top: 14px;
  border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: 12.5px; }
.doc-foot .copilotz-time { font-size: 12.5px; }
.doc-loading { display: grid; gap: 14px; }

.doc-counts { display: inline-flex; gap: 6px; font: 600 12px/1 var(--font-mono); font-variant-numeric: tabular-nums;
  font-variant-ligatures: none; white-space: nowrap; }
.doc-added { color: var(--success-text); }
.doc-removed { color: var(--destructive-text); }
.doc-diff { width: 100%; }

.doc-conflict { display: grid; gap: 18px; min-width: 0; }
.doc-conflict-head { display: flex; gap: 14px; padding: 16px 18px; border: 1px solid var(--warning-border);
  border-radius: var(--radius-xl); background: var(--warning-soft); }
.doc-conflict-icon { flex: none; display: grid; place-items: center; width: 36px; height: 36px;
  border-radius: var(--radius-lg); background: color-mix(in oklab, var(--warning) 22%, var(--background));
  color: var(--warning-text); }
.doc-conflict-head h2 { margin: 2px 0 6px; font-family: var(--font-display); font-size: 17px; font-weight: 660;
  line-height: 1.3; letter-spacing: -.01em; }
.doc-conflict-head p { margin: 0; color: var(--foreground); font-size: 14px; line-height: 1.6; }
.doc-conflict-head p .copilotz-avatar { vertical-align: -4px; }
.doc-conflict-head p .copilotz-time { font-size: 14px; }
.doc-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.doc-choice { display: grid; align-content: start; gap: 6px; padding: 14px 16px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); color: var(--card-foreground); font: inherit;
  text-align: left; cursor: pointer; transition: border-color .15s, background-color .15s; }
.doc-choice:hover:not(:disabled) { border-color: var(--primary-border);
  background: color-mix(in oklab, var(--primary-soft) 45%, var(--card)); }
.doc-choice:disabled { opacity: .6; cursor: progress; }
.doc-choice-primary { border-color: var(--primary-border); }
.doc-choice-name { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 14.5px; }
.doc-choice-says { color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
.doc-conflict-diff { display: grid; gap: 12px; min-width: 0; }
.doc-conflict-titles { margin: 0; color: var(--muted-foreground); font-size: 13.5px; }
.doc-hand { display: grid; gap: 14px; min-width: 0; }
.doc-hand-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.doc-hand-head p { margin: 0; color: var(--muted-foreground); font-size: 13.5px; }
.doc-clash { overflow: hidden; transition: border-color .15s; }
.doc-clash[data-settled] { border-color: var(--success-border); }
.doc-clash-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 10px 14px;
  border-bottom: 1px solid var(--border); font-size: 13.5px; }
.doc-clash-near { flex: 1; min-width: 0; overflow: hidden; color: var(--muted-foreground); text-overflow: ellipsis;
  white-space: nowrap; }
.doc-clash-sides { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; padding: 12px 14px 0; }
.doc-clash-picks { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 14px 14px; }
.doc-own { display: grid; gap: 0; padding: 12px 14px 0; }
.doc-own .doc-clash-picks { padding-inline: 0; }
.doc-hand-foot { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; }
@container copilotz-page (max-width: 720px) {
  .doc-choices, .doc-clash-sides { grid-template-columns: minmax(0, 1fr); }
}

.copilotz-drawer:has(> .doc-history) { width: min(100vw, 620px); }
.doc-history { padding-bottom: 16px; }
.doc-history-list { list-style: none; display: grid; gap: 2px; margin: 0; padding: 2px 10px 16px; }
.doc-version-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  width: 100%; padding: 10px; border: 0; border-radius: var(--radius-lg); background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer; transition: background-color .12s; }
.doc-version-row:hover { background: var(--accent); }
.doc-version-row[aria-current] { background: color-mix(in oklab, var(--primary-soft) 60%, transparent); }
.doc-version-text { display: grid; gap: 2px; min-width: 0; }
.doc-version-top { display: flex; align-items: center; gap: 6px; font-size: 14px; }
.doc-version-what { overflow: hidden; color: var(--muted-foreground); font-size: 12.5px; text-overflow: ellipsis;
  white-space: nowrap; }
.doc-version-end { display: grid; justify-items: end; gap: 4px; color: var(--muted-foreground); font-size: 12px; }
.doc-version-end .copilotz-time { font-size: 12px; }
.doc-history-one { display: grid; justify-items: start; gap: 10px; padding: 0 18px 16px 14px; }
.doc-version { display: grid; gap: 14px; width: 100%; min-width: 0; }
.doc-version-head { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 12px; }
.doc-version-head h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-family: var(--font-display);
  font-size: 17px; font-weight: 660; }
.doc-version-head p { margin: 2px 0 0; color: var(--muted-foreground); font-size: 13px; }
.doc-version-head .copilotz-time { font-size: 13px; }
.doc-version-renamed { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--muted-foreground);
  font-size: 13px; }
.doc-version-read { position: relative; padding: 16px 18px; border: 1px solid var(--border);
  border-radius: var(--radius-lg); background: var(--card); }
.doc-version-copy { position: absolute; top: 8px; right: 8px; }
.doc-version-title { margin: 0 40px 12px 0; font-family: var(--font-display); font-size: 21px; font-weight: 680;
  letter-spacing: -.02em; overflow-wrap: anywhere; }
.doc-version-foot { display: grid; justify-items: start; }
.doc-version-ask { display: inline-flex; gap: 6px; }

.docs { display: grid; gap: 14px; min-width: 0; }
.docs-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.docs-intro { margin: 0; max-width: 560px; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.docs-search { flex: 1; min-width: 180px; }
.docs-list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.docs-item { position: relative; }
.docs-row { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; align-items: start; gap: 14px; width: 100%;
  padding: 14px 54px 14px 14px; border: 1px solid var(--border); border-radius: var(--radius-xl); background: var(--card);
  color: var(--card-foreground); font: inherit; text-align: left; text-decoration: none; cursor: pointer;
  transition: border-color .15s, box-shadow .15s, background-color .15s; }
.docs-row:hover { border-color: color-mix(in oklab, var(--primary) 28%, var(--border)); box-shadow: var(--shadow-sm); }
.docs-row-icon { display: grid; place-items: center; width: 38px; height: 38px; border-radius: var(--radius-lg);
  background: var(--primary-soft); color: var(--primary-text); }
.docs-row-text { display: grid; gap: 3px; min-width: 0; }
.docs-row-title { font-size: 15px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
.docs-row-excerpt { display: -webkit-box; overflow: hidden; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.5;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.docs-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 4px;
  color: var(--muted-foreground); font-size: 12.5px; }
.docs-row-meta .copilotz-time { font-size: 12.5px; }
.docs-row-here { display: flex; align-items: center; gap: 8px; align-self: center; }
.docs-row-editing { color: var(--warning-text); font-size: 12px; font-weight: 560; white-space: nowrap; }
.docs-row-menu { position: absolute; top: 13px; right: 10px; }
.docs-none { margin: 10px 0; color: var(--muted-foreground); text-align: center; }
.docs-empty { margin: 26px auto 4px; }
.docs-start { display: grid; justify-items: center; gap: 10px; text-align: center; }
.docs-start-label { margin: 0; color: var(--muted-foreground); font-size: 12px; font-weight: 650; letter-spacing: .06em;
  text-transform: uppercase; }
.docs-start-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.docs-start-hint { display: flex; align-items: flex-start; gap: 7px; max-width: 520px; margin: 8px auto 0;
  color: var(--muted-foreground); font-size: 13px; line-height: 1.5; text-align: left; }
.docs-start-hint .copilotz-icon { flex: none; margin-top: 2px; color: var(--primary-text); }
@container copilotz-page (max-width: 560px) {
  .docs-row { grid-template-columns: 32px minmax(0, 1fr); padding: 12px 46px 12px 12px; gap: 12px; }
  .docs-row-icon { width: 32px; height: 32px; border-radius: var(--radius-md); }
  .docs-row-here { grid-column: 2; align-self: start; }
  .docs-row-menu { top: 10px; right: 6px; }
}
.docs-compact { gap: 10px; }
.docs-compact .docs-row { grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 9px 42px 9px 10px; border-radius: var(--radius-lg); }
.docs-compact .docs-row-icon { width: 28px; height: 28px; border-radius: var(--radius-md); }
.docs-compact .docs-row-title { font-size: 14px; }
.docs-compact .docs-row-meta { margin-top: 1px; font-size: 12px; }
.docs-compact .docs-row-menu { top: 50%; right: 6px; transform: translateY(-50%); }
.docs-compact .docs-empty { margin-top: 10px; }
.docs-reader-back { margin: -4px 0 -2px -8px; }

.doc-reader { display: grid; gap: 12px; min-width: 0; }
.doc-reader-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding-bottom: 12px; border-bottom: 1px solid var(--border); }
.doc-reader-head h2 { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 680;
  letter-spacing: -.015em; line-height: 1.3; overflow-wrap: anywhere; }
.doc-reader-head p { margin: 3px 0 0; color: var(--muted-foreground); font-size: 12.5px; }
.doc-reader-head .copilotz-time { font-size: 12.5px; }

.doc-step { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  max-width: 520px; padding: 9px 10px 9px 11px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); }
.doc-step-icon { display: grid; place-items: center; width: 34px; height: 34px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.doc-step-text { display: grid; gap: 2px; min-width: 0; }
.doc-step-title { overflow: hidden; color: var(--foreground); font-weight: 650; text-decoration: none;
  text-overflow: ellipsis; white-space: nowrap; }
.doc-step-title:hover { text-decoration: underline; text-underline-offset: 2px; }
.doc-step-what { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--muted-foreground);
  font-size: 12.5px; }
.doc-step-line { display: inline-flex; align-items: center; gap: 7px; color: var(--muted-foreground); font-size: 13px; }
.doc-step-line[data-failed] { color: var(--destructive-text); }
.doc-step-link { color: var(--primary-text); font-weight: 600; text-decoration: none; }
.doc-step-link:hover { text-decoration: underline; text-underline-offset: 2px; }

.doc-missing { display: grid; gap: 18px; max-width: 520px; margin: 14vh auto; padding: 0 16px; }
`;
