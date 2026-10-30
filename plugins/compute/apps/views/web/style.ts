/**
 * Apps' layout on the web, on the theme's variables: publishing a job (its
 * button in the job's row, its dialog, an app as it builds), and a space's
 * apps. Only layout: the pieces are the toolkit's.
 */
export const STYLE = `
/* In a job's row */
.publish-trigger { gap: 6px; }
.publish-trigger[data-status=live] { color: var(--success-text); }
.publish-trigger[data-status=building] { color: var(--info-text); }
.publish-trigger[data-status=failed] { color: var(--destructive-text); }

/* Publishing */
.publish-form { display: grid; gap: 16px; }
.publish-address { display: flex; align-items: center; gap: 8px; min-width: 0; margin: -8px 0 0; padding: 9px 12px;
  border-radius: var(--radius-lg); background: var(--muted); color: var(--secondary-foreground); font-size: 13.5px; }
.publish-address .copilotz-icon { color: var(--primary-text); }
.publish-address code { font-size: 13px; font-weight: 600; color: var(--foreground); overflow-wrap: anywhere; }
.publish-address-note { color: var(--muted-foreground); font-size: 12.5px; }
.publish-row { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 12px; align-items: start; }
.publish-folder-box { display: flex; align-items: center; min-width: 0; }
.publish-row > * { min-width: 0; }
.publish-port .copilotz-input { width: 100%; }
.publish-port input { width: 100%; }
.publish-folder-base { flex: none; max-width: 45%; padding: 0 10px; height: 40px; display: inline-flex; align-items: center;
  border: 1px solid var(--input); border-right: 0; border-radius: var(--radius-lg) 0 0 var(--radius-lg);
  background: var(--muted); color: var(--muted-foreground); font: 12.5px var(--font-mono); overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.publish-folder-base + .copilotz-input { flex: 1; min-width: 0; border-radius: 0 var(--radius-lg) var(--radius-lg) 0; }
.publish-folder input { font-family: var(--font-mono); font-size: 13.5px; }
.publish-port input { font-variant-numeric: tabular-nums; }
.publish-how { display: flex; align-items: flex-start; gap: 8px; margin: 0; color: var(--muted-foreground); font-size: 13px;
  line-height: 1.5; }
.publish-how .copilotz-icon { flex: none; margin-top: 2px; }
.publish-how code { font-size: .92em; overflow-wrap: anywhere; }
.publish-go { display: flex; justify-content: flex-end; gap: 8px; padding-top: 14px; border-top: 1px solid var(--border); }
@media (max-width: 560px) {
  .publish-row { grid-template-columns: minmax(0, 1fr); }
}

/* An app as it goes */
.app-status { display: flex; align-items: flex-start; gap: 14px; }
.app-status-icon { display: grid; place-items: center; flex: none; width: 46px; height: 46px; border-radius: var(--radius-full);
  background: var(--info-soft); color: var(--info-text); }
.app-status[data-status=live] .app-status-icon { background: var(--success-soft); color: var(--success-text); }
.app-status[data-status=failed] .app-status-icon { background: var(--destructive-soft); color: var(--destructive-text); }
.app-status-text { display: grid; gap: 8px; flex: 1; min-width: 0; }
.app-status-text > p { margin: 0; color: var(--muted-foreground); line-height: 1.55; }
.app-status-text > .app-status-title { color: var(--foreground); font-size: 16px; font-weight: 650; }
.app-status-meta { font-size: 12.5px; font-variant-numeric: tabular-nums; }
.app-status-meta code { font-size: 12px; }
.app-status-url { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
.app-status-url a { color: var(--primary-text); font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.app-status-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.app-building { position: relative; height: 4px; border-radius: var(--radius-full); background: var(--muted); overflow: hidden; }
.app-building > span { position: absolute; inset: 0 auto 0 0; width: 34%; border-radius: var(--radius-full); background: var(--info);
  animation: app-building 1.6s ease-in-out infinite; }
@keyframes app-building { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
@media (prefers-reduced-motion: reduce) { .app-building > span { animation: none; width: 100%; opacity: .5; } }

/* A space's apps */
.apps { display: grid; gap: 12px; }
.apps-intro { margin: 0 2px; color: var(--muted-foreground); font-size: 13.5px; }
.apps-list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.apps-empty { margin-top: 24px; }
.apps-empty code { font-size: .92em; }
.app { overflow: hidden; }
.app-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  padding: 12px 12px 12px 14px; }
.app-icon { display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-lg);
  background: var(--muted); color: var(--muted-foreground); }
.app[data-status=live] .app-icon { background: var(--success-soft); color: var(--success-text); }
.app[data-status=building] .app-icon { background: var(--info-soft); color: var(--info-text); }
.app[data-status=failed] .app-icon { background: var(--destructive-soft); color: var(--destructive-text); }
.app-text { display: grid; gap: 2px; min-width: 0; }
.app-name { display: flex; align-items: center; gap: 8px; min-width: 0; margin: 0; font-weight: 620; }
.app-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-url { display: flex; align-items: center; gap: 2px; min-width: 0; margin: 0; font-size: 13.5px; }
.app-url a, .app-url > span { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.app-url a { color: var(--primary-text); font-weight: 560; text-decoration: none; }
.app-url a:hover { text-decoration: underline; text-underline-offset: 3px; }
.app-url > span { color: var(--muted-foreground); }
.app-meta { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.app-meta code { font-size: 12px; }
.app-meta .copilotz-time { font-size: 12.5px; }
.app-actions { display: flex; align-items: center; gap: 4px; }
.app > .app-building { margin: 0 14px 12px 62px; }
.app-problem { padding: 0 12px 12px 62px; }
.app-error { margin: 0 14px 10px 62px; color: var(--destructive-text); font-size: 13px; }
.apps-dialog-text { margin: 0 0 12px; line-height: 1.55; }
.apps-dialog-text code { font-size: .92em; }
.apps-compact .app-row { grid-template-columns: 30px minmax(0, 1fr) auto; gap: 10px; padding: 10px; }
.apps-compact .app-icon { width: 30px; height: 30px; }
.apps-compact .app-meta { display: none; }
@media (max-width: 560px) {
  .app-row { grid-template-columns: 36px minmax(0, 1fr); }
  .app-actions { grid-column: 2; }
  .app > .app-building, .app-problem, .app-error { margin-left: 14px; padding-left: 0; }
  .app-problem { padding-right: 14px; }
}
`;
