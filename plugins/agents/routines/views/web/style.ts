/**
 * Routines' layout on the web, on the theme's variables: a space's Routines
 * tab (each routine a row: who it asks, when, how its last run went), the
 * form a routine is made with (its schedule picker, with what it says and
 * its next runs), a routine's page (what it does, and its runs), and one
 * made from a conversation. Only layout: the pieces are the toolkit's.
 */
export const STYLE = `
/* A space's routines: its tab */
.routines { container: routines / inline-size; display: grid; gap: 18px; }
.routines-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.routines-intro { flex: 1 1 320px; margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.routines-list { list-style: none; display: grid; margin: 0; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); }
.routines-item { position: relative; }
.routines-item + .routines-item { border-top: 1px solid var(--border); }
.routines-item[data-fresh] { animation: routines-fresh 1.6s ease-out; border-radius: var(--radius-lg); }
@keyframes routines-fresh { from { background: var(--primary-soft); } }
.routines-row { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; align-items: center; gap: 12px;
  min-height: 68px; padding: 10px 92px 10px 10px; border-radius: var(--radius-lg); color: inherit;
  text-decoration: none; transition: background-color .12s; }
.routines-row:hover { background: var(--accent); cursor: pointer; }
.routines-row[data-quiet] .routines-row-link, .routines-row[data-quiet] .copilotz-avatar { opacity: .62; }
.routines-row-text { display: grid; gap: 3px; min-width: 0; }
.routines-row-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-weight: 600; }
.routines-row-link { overflow: hidden; color: inherit; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.routines-row-link::after { content: ""; position: absolute; inset: 0; border-radius: var(--radius-lg); }
.routines-row-link:focus-visible { outline: 0; }
.routines-row-link:focus-visible::after { outline: 2px solid var(--ring); outline-offset: -2px; }
.routines-row-when { overflow: hidden; color: var(--muted-foreground); font-size: 13px; text-overflow: ellipsis;
  white-space: nowrap; }
.routines-row-when b { color: var(--secondary-foreground); font-weight: 560; }
.routines-row-next { display: grid; justify-items: end; gap: 2px; color: var(--muted-foreground); font-size: 12px;
  text-align: right; white-space: nowrap; }
.routines-row-next strong { color: var(--foreground); font-size: 13px; font-weight: 600; }
.routines-row-last { position: relative; z-index: 1; display: inline-flex; align-items: center; gap: 4px;
  color: inherit; text-decoration: none; }
a.routines-row-last:hover { color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; }
.routines-row-last .copilotz-icon { opacity: .7; }
.routines-row-last[data-tone=failed] { color: var(--warning-text); }
.routines-row-last[data-tone=forbidden] { color: var(--destructive-text); }
.routines-row-soon { display: none; color: var(--secondary-foreground); font-size: 12.5px; }
.routines-row-actions { position: absolute; top: 50%; right: 8px; display: flex; gap: 2px; transform: translateY(-50%); }
.routines-none { margin: 4px 2px; color: var(--muted-foreground); font-size: 13px; text-align: center; }
.routines-empty { margin: 28px auto 4px; max-width: 560px; }
.routines-examples { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 0;
  list-style: none; }
.routines-example { display: grid; align-content: start; gap: 6px; width: 100%; height: 100%; padding: 14px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); color: inherit;
  font: inherit; text-align: left; cursor: pointer; transition: border-color .15s, transform .15s, box-shadow .15s; }
.routines-example:hover:not(:disabled) { border-color: var(--primary-border); box-shadow: var(--shadow-sm);
  transform: translateY(-1px); }
.routines-example:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.routines-example:disabled { cursor: default; }
.routines-example-when { display: inline-flex; align-items: center; gap: 6px; color: var(--primary-text);
  font-size: 12px; font-weight: 650; letter-spacing: .02em; }
.routines-example b { font-size: 14px; }
.routines-example span:last-child { color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
.routines-compact { gap: 12px; }
.routines-compact .routines-row { grid-template-columns: minmax(0, 1fr); min-height: 56px; padding: 8px 76px 8px 10px; }
.routines-compact .routines-row > .copilotz-avatar, .routines-compact .routines-row-next { display: none; }
.routines-compact .routines-examples { grid-template-columns: 1fr; }
@container routines (max-width: 560px) {
  .routines-row { grid-template-columns: 32px minmax(0, 1fr); padding-right: 84px; }
  .routines-row-next { display: none; }
  .routines-row-soon { display: block; }
  .routines-examples { grid-template-columns: 1fr; }
}

/* The form: what, to whom, when, where */
.routine-form { container: routine-form / inline-size; display: grid; gap: 20px; }
.routine-form :is(input, textarea, select, button) { scroll-margin-bottom: 84px; }
.routine-field { display: grid; gap: 7px; min-width: 0; }
.routine-label { font-size: 13.5px; font-weight: 600; }
.routine-note { margin: 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.routine-error { margin: 0; color: var(--destructive-text); font-size: 12.5px; line-height: 1.45; }
.routine-agents { display: flex; flex-wrap: wrap; gap: 6px; }
.routine-agent { display: inline-flex; align-items: center; gap: 8px; min-height: 38px; padding: 4px 12px 4px 5px;
  border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--card); color: inherit;
  font: inherit; font-size: 13.5px; cursor: pointer; transition: border-color .12s, background-color .12s; }
.routine-agent:hover { background: var(--accent); }
.routine-agent[aria-checked=true] { border-color: var(--ring); background: var(--primary-soft);
  outline: 2px solid color-mix(in oklab, var(--ring) 22%, transparent); }
.routine-agent:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.routine-agent small { color: var(--muted-foreground); font: 500 11.5px var(--font-mono); }
.routine-posts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.routine-post { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 10px; padding: 12px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); cursor: pointer;
  transition: border-color .12s, background-color .12s; }
.routine-post:has(input:checked) { border-color: var(--ring); background: color-mix(in oklab, var(--primary-soft) 60%, var(--card)); }
.routine-post:has(input:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
.routine-post input { margin: 3px 0 0; accent-color: var(--primary); }
.routine-post b { display: block; font-size: 13.5px; }
.routine-post span { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.4; }
.routine-form-end { position: sticky; bottom: -22px; z-index: 1; display: flex; align-items: center; justify-content: flex-end;
  gap: 10px; margin: 0 -22px -22px; padding: 12px 22px 16px; border-top: 1px solid var(--border);
  background: var(--popover); }
.routine-form-end .routine-note, .routine-form-end .routine-error { flex: 1; min-width: 0; }
.routine-page .routine-form-end { position: static; margin: 0; padding: 14px 0 0; background: transparent; }
@container routine-form (max-width: 520px) { .routine-posts { grid-template-columns: 1fr; } }

/* The schedule picker */
.picker { display: grid; gap: 12px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-xl);
  background: color-mix(in oklab, var(--muted) 30%, var(--card)); }
.picker-kinds { display: flex; flex-wrap: wrap; gap: 6px; }
.picker-kind { min-height: 32px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-full);
  background: var(--card); color: var(--secondary-foreground); font: inherit; font-size: 13px; font-weight: 560;
  cursor: pointer; transition: background-color .12s, border-color .12s, color .12s; }
.picker-kind:hover { background: var(--accent); }
.picker-kind[aria-checked=true] { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
.picker-kind:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.picker-row { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 12px; }
.picker-row > label { display: grid; gap: 5px; color: var(--muted-foreground); font-size: 12.5px; font-weight: 560; }
.picker-time .copilotz-input { width: 132px; }
.picker-at .copilotz-input { width: 220px; }
.picker-zone { flex: 1 1 220px; min-width: 0; }
.picker-zone .copilotz-select { width: 100%; }
.picker-cron { flex: 1 1 220px; }
.picker-cron .copilotz-input input { font-family: var(--font-mono); font-size: 14px; }
.picker-days { display: flex; gap: 4px; }
.picker-day { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 1px solid var(--border);
  border-radius: var(--radius-full); background: var(--card); color: var(--secondary-foreground); font: inherit;
  font-size: 13px; font-weight: 650; cursor: pointer; transition: background-color .12s, border-color .12s; }
.picker-day:hover { background: var(--accent); }
.picker-day[aria-pressed=true] { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
.picker-day:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.picker-every { display: inline-flex; align-items: center; gap: 8px; color: var(--secondary-foreground); font-size: 14px; }
.picker-every .copilotz-select { width: 84px; }
.picker-help { margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.picker-help code { font: 500 12px var(--font-mono); }
.picker-says { display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--radius-lg); background: var(--card);
  border: 1px solid var(--border); }
.picker-says[data-bad] { border-color: var(--destructive-border); background: var(--destructive-soft); }
.picker-says-what { display: flex; align-items: center; gap: 8px; margin: 0; font-weight: 600; font-size: 14px; }
.picker-says-what .copilotz-icon { color: var(--primary-text); }
.picker-says[data-bad] .picker-says-what { color: var(--destructive-text); font-weight: 560; }
.picker-says-next { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; }
.picker-says-next li { padding: 3px 10px; border-radius: var(--radius-full); background: var(--muted);
  color: var(--secondary-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; }
.picker-says-next li:first-child { background: var(--primary-soft); color: var(--primary-text); font-weight: 600; }

/* A routine's page */
.routine-page { display: grid; gap: 18px; }
.routine-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 14px 24px; margin: 0;
  padding: 18px 20px; }
.routine-facts dt { color: var(--muted-foreground); font-size: 13px; font-weight: 560; }
.routine-facts dd { display: grid; gap: 6px; min-width: 0; margin: 0; font-size: 14px; }
.routine-said { margin: 0; padding: 10px 14px; border-left: 3px solid var(--primary-border); border-radius: var(--radius-sm);
  background: color-mix(in oklab, var(--muted) 50%, var(--card)); line-height: 1.55; white-space: pre-wrap;
  overflow-wrap: anywhere; }
.routine-who { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.routine-who:hover span { text-decoration: underline; text-underline-offset: 3px; }
.routine-who small { color: var(--muted-foreground); font: 500 12px var(--font-mono); }
.routine-next { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.routine-next li { padding: 2px 9px; border-radius: var(--radius-full); background: var(--muted); color: var(--secondary-foreground);
  font-size: 12.5px; }
.routine-next li:first-child { background: var(--primary-soft); color: var(--primary-text); font-weight: 600; }
.routine-runs { display: grid; gap: 8px; }
.routine-runs h2 { display: flex; align-items: center; gap: 8px; margin: 0 2px; font-size: 15px; font-weight: 650; }
.routine-runs-count { color: var(--muted-foreground); font-size: 12.5px; font-weight: 500; }
.routine-run-list { list-style: none; display: grid; margin: 0; padding: 4px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); }
.routine-run { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  min-height: 52px; padding: 8px 10px; }
.routine-run + .routine-run { border-top: 1px solid var(--border); }
.routine-run-mark { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-full);
  background: var(--success-soft); color: var(--success-text); }
.routine-run-mark[data-outcome=failed] { background: var(--warning-soft); color: var(--warning-text); }
.routine-run-mark[data-outcome=forbidden] { background: var(--destructive-soft); color: var(--destructive-text); }
.routine-run-text { display: grid; gap: 2px; min-width: 0; font-size: 13.5px; }
.routine-run-text span { color: var(--muted-foreground); font-size: 12.5px; overflow-wrap: anywhere; }
.routine-run-text .copilotz-time { font-size: 12.5px; }
.routine-missing { display: grid; min-height: 60vh; place-items: center; padding: 24px; }
.routine-loading { display: grid; gap: 14px; }
.routine-edit-card { padding: 20px 22px 22px; }
.routine-delete-means { display: grid; gap: 10px; margin: 0; padding-left: 18px; color: var(--secondary-foreground);
  font-size: 14px; line-height: 1.5; }
@media (max-width: 640px) {
  .routine-facts { grid-template-columns: 1fr; gap: 4px; padding: 14px 16px; }
  .routine-facts dd + dt { margin-top: 10px; }
  .routine-wide { display: none; }
}
@media (min-width: 641px) { .routine-narrow { display: none; } }

/* Made from a conversation */
.routine-step { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  max-width: 520px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); }
.routine-step-mark { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.routine-step-text { display: grid; gap: 1px; min-width: 0; font-size: 13.5px; }
.routine-step-text b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.routine-step-text span { color: var(--muted-foreground); font-size: 12.5px; }
.routine-step-plain { display: inline-flex; align-items: center; gap: 6px; color: var(--muted-foreground); font-size: 13px; }
`;
