/**
 * Usage's layout on the web, on the theme's variables: the filters in one
 * row; the headline (the amount large, the rest one sentence, the budget's
 * meter with where in the month we are); the chips the page is kept to;
 * the switch, the stacked chart (its series in the theme's chart colours,
 * the rest grey, hairline grid, its tooltip, its table) and the ranked rows
 * (each a button: its colour, face, share bar, amount); the activity list
 * and a turn's calls. Staff's cost and margin in the warning colour, as the
 * shell marks staff. Only layout and the charts' marks: the pieces are the
 * toolkit's.
 */
export const STYLE = `
.usage { --usage-other: color-mix(in oklab, var(--muted-foreground) 42%, var(--card));
  container: usage / inline-size; display: grid; gap: 16px; min-width: 0; }
.usage[data-loading] :is(.usage-card, .usage-head) { opacity: .62; transition: opacity .2s; }
.usage-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.usage-filters-gap { flex: 1; }
.usage-period { min-width: 170px; }
.usage-whose-pick { min-width: 130px; }
.usage-whose { display: flex; align-items: center; gap: 7px; margin: -4px 2px 0; color: var(--muted-foreground);
  font-size: 13px; }
.usage-quiet { color: var(--muted-foreground); }
.usage-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

/* The headline: one line, and its second */
.usage-head { display: grid; gap: 8px; min-width: 0; padding: 2px 2px 0; }
.usage-headline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 0; margin: 0;
  color: var(--secondary-foreground); font-size: 15px; line-height: 1.45; font-variant-numeric: tabular-nums; }
.usage-headline > span:first-of-type { margin-right: 2px; }
.usage-amount { margin-right: 8px; color: var(--foreground); font-family: var(--font-display, var(--font-sans));
  font-size: 30px; font-weight: 680; letter-spacing: -.02em; line-height: 1.15; }
.usage-dot::before { content: "·"; margin: 0 8px; color: var(--muted-foreground); }
.usage-left { font-weight: 600; color: var(--foreground); }
.usage-left[data-tone=near] { color: var(--warning-text); }
.usage-left[data-tone=out] { display: inline-flex; align-items: center; gap: 5px; color: var(--warning-text); }
.usage-meter-budget { position: relative; height: 6px; max-width: 520px; border-radius: var(--radius-full);
  background: color-mix(in oklab, var(--chart-1, var(--primary)) 14%, transparent); }
.usage-meter-budget > span { display: block; height: 100%; border-radius: inherit;
  background: var(--chart-1, var(--primary)); transition: width .3s ease-out; }
.usage-meter-budget[data-tone] { background: color-mix(in oklab, var(--warning) 20%, transparent); }
.usage-meter-budget[data-tone] > span { background: var(--warning); }
.usage-meter-now { position: absolute; top: -3px; width: 2px; height: 12px; margin-left: -1px; border-radius: var(--radius-xs);
  background: var(--foreground); opacity: .55; }
.usage-subline { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 0; margin: 0;
  color: var(--muted-foreground); font-size: 13.5px; line-height: 1.5; font-variant-numeric: tabular-nums; }
.usage-delta { color: var(--secondary-foreground); font-weight: 620; }
.usage-delta > span { color: var(--muted-foreground); font-weight: 450; }
.usage-billing { margin-left: auto; padding-left: 12px; color: var(--primary-text, var(--primary)); font-weight: 600;
  text-decoration: none; white-space: nowrap; }
.usage-billing:hover { text-decoration: underline; text-underline-offset: 3px; }
.usage-staff-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; margin: 2px 0 0;
  padding: 7px 10px; border: 1px solid var(--warning-border); border-radius: var(--radius-md);
  background: var(--warning-soft); color: var(--warning-text); font-size: 13px; font-variant-numeric: tabular-nums; }
.usage-staff-line .copilotz-badge { gap: 4px; margin-right: 10px; }
.usage-staff-line b { font-weight: 650; }

/* What the page is kept to */
.usage-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: -4px 0 -2px; }
.usage-chips-label { color: var(--muted-foreground); font-size: 12.5px; }
.usage-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-height: 28px;
  padding: 2px 4px 2px 11px; border: 1px solid var(--primary-border, var(--border)); border-radius: var(--radius-full);
  background: var(--primary-soft); color: var(--primary-text, var(--foreground)); font-size: 13px; font-weight: 560; }
.usage-chip-what { font-weight: 450; opacity: .8; }
.usage-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-chip-x { display: grid; place-items: center; flex: none; width: 22px; height: 22px; padding: 0; border: 0;
  border-radius: var(--radius-full); background: transparent; color: inherit; cursor: pointer; }
.usage-chip-x:hover { background: color-mix(in oklab, var(--primary) 16%, transparent); }

/* Cards */
.usage-card { display: grid; gap: 12px; min-width: 0; }
.usage-card > * { min-width: 0; }
.usage-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; }
.usage-card-head h3 { margin: 0; font-size: 14.5px; font-weight: 650; }
.usage-card-head p { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0;
  color: var(--muted-foreground); font-size: 12.5px; }
.usage-empty { padding: 28px 16px; }

/* The stacked chart */
.usage-chart { display: grid; gap: 2px; }
.usage-chart-plot { position: relative; min-width: 0; }
.usage-chart-plot svg { display: block; overflow: visible; border-radius: var(--radius-sm); }
.usage-chart-plot svg:focus-visible { outline: 2px solid var(--ring); outline-offset: 4px; }
.usage-tick line { stroke: var(--border); stroke-width: 1; shape-rendering: crispEdges; }
.usage-tick text, .usage-axis { fill: var(--muted-foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.usage-day :is(path, rect:not(.usage-hit)) { transition: opacity .12s; }
.usage-day [data-back] { opacity: .28; }
.usage-chart-plot svg:has(.usage-day[data-on]) .usage-day:not([data-on]) :is(path, rect:not(.usage-hit)) { opacity: .45; }
.usage-later { fill: var(--muted); }
.usage-today { fill: var(--foreground); opacity: .6; }
.usage-hit { fill: transparent; cursor: default; }
.usage-tip { position: absolute; z-index: 3; display: grid; gap: 2px; min-width: 170px; max-width: 260px; padding: 8px 11px;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-md); font-size: 12px; line-height: 1.4;
  pointer-events: none; transform: translate(-50%, -100%); }
.usage-tip-day { color: var(--muted-foreground); }
.usage-tip-value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.usage-tip-row { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: center; gap: 7px; }
.usage-tip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--secondary-foreground); }
.usage-tip-num { font-variant-numeric: tabular-nums; }
.usage-chart-foot { display: flex; justify-content: flex-end; margin: -2px -6px 0 0; }
.usage-key { display: inline-block; flex: none; width: 10px; height: 10px; border-radius: var(--radius-xs); }
.usage-table-box { max-height: 320px; overflow: auto; border-top: 1px solid var(--border); }

/* Tables: the chart's numbers, a turn's calls */
.usage-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.usage-table th, .usage-table td { padding: 7px 10px; border-bottom: 1px solid var(--border); text-align: left;
  white-space: nowrap; }
.usage-table thead th { position: sticky; top: 0; background: var(--card); color: var(--muted-foreground);
  font-size: 11.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
.usage-table tbody th { font-weight: 500; }
.usage-table tbody tr:last-child > * { border-bottom: 0; }
.usage-num { text-align: right !important; font-variant-numeric: tabular-nums; }
.usage-wide { overflow-x: auto; }
.usage-staff-col { background: var(--warning-soft); }
.usage-table thead th.usage-staff-col { background: var(--warning-soft); }
.usage-staff-th { display: inline-flex; align-items: center; gap: 4px; color: var(--warning-text); }

/* The switch, and the ranked rows */
.usage-by-head h3 { margin-right: auto; }
.usage-rows { list-style: none; display: grid; gap: 2px; margin: 4px -8px 0; padding: 0; }
.usage-row { display: grid; grid-template-columns: 4px 26px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  width: 100%; padding: 7px 8px; border: 0; border-radius: var(--radius-md); background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer; transition: background-color .15s, opacity .15s; }
.usage-row:hover { background: var(--accent); }
.usage-row[aria-pressed=true] { background: var(--primary-soft); outline: 1px solid var(--primary-border, var(--border)); outline-offset: -1px; }
.usage-row[data-back] { opacity: .62; }
.usage-row[data-back]:hover { opacity: 1; }
.usage-swatch { align-self: stretch; width: 4px; border-radius: var(--radius-full); }
.usage-row-text { display: grid; gap: 4px; min-width: 0; }
.usage-row-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; font-size: 13.5px; font-weight: 600; }
.usage-row-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-row-detail { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--muted-foreground); font-size: 12px; font-weight: 450; }
.usage-row-meter { display: block; height: 4px; border-radius: var(--radius-full); background: var(--muted); overflow: hidden; }
.usage-row-meter > span { display: block; height: 100%; border-radius: var(--radius-full); }
.usage-row-more { color: var(--muted-foreground); font-size: 12px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-variant-numeric: tabular-nums; }
.usage-row-staff { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--warning-text);
  font-size: 11.5px; font-weight: 450; overflow: hidden; white-space: nowrap; font-variant-numeric: tabular-nums; }
.usage-row-value { display: grid; justify-items: end; font-size: 13.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.usage-row-share { color: var(--muted-foreground); font-size: 11.5px; font-weight: 500; }
.usage-face { display: grid; place-items: center; flex: none; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--muted-foreground); }
.usage-face-model { border-radius: var(--radius-sm); background: var(--primary-soft); color: var(--primary-text); }
.usage-more { justify-self: start; margin: -6px 0 -4px -8px; }

/* Activity */
.usage-activity { gap: 0; overflow: hidden; }
.usage-activity-head { padding: 14px 16px 8px; }
.usage-items { list-style: none; margin: 0; padding: 0 0 6px; }
.usage-item { min-width: 0; }
.usage-item + .usage-item { border-top: 1px solid var(--border); }
.usage-item-main { display: grid; grid-template-columns: 52px 28px minmax(0, 1fr) auto 28px; align-items: center;
  gap: 10px; padding: 9px 12px 9px 16px; }
.usage-item-when { color: var(--muted-foreground); font-size: 12px; }
.usage-item-main > .usage-face, .usage-item-main > .copilotz-avatar { width: 28px; height: 28px; }
.usage-item-text { display: grid; gap: 1px; min-width: 0; }
.usage-item-title { overflow: hidden; color: var(--foreground); font-size: 13.5px; font-weight: 560;
  text-overflow: ellipsis; white-space: nowrap; }
.usage-item-details { overflow: hidden; color: var(--muted-foreground); font-size: 12px; text-overflow: ellipsis;
  white-space: nowrap; font-variant-numeric: tabular-nums; }
.usage-item-pad { width: 28px; }
.usage-price { display: grid; justify-items: end; font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums;
  white-space: nowrap; }
.usage-price-staff { color: var(--warning-text); font-size: 11px; font-weight: 500; }
.usage-calls-box { margin: 0 12px 10px 54px; border: 1px solid var(--border); border-radius: var(--radius-md); }
.usage-calls td { color: var(--secondary-foreground); }
.usage-calls .usage-price { font-size: 13px; font-weight: 500; }
.usage-model { display: inline-flex; align-items: baseline; gap: 6px; color: var(--foreground); font-weight: 520; }
.usage-none { margin: 0; padding: 4px 16px 16px; color: var(--muted-foreground); font-size: 13px; }
.usage-more-items { margin: 0 0 10px 8px; }
.usage-unpriced { display: flex; align-items: flex-start; gap: 7px; margin: 0 2px; color: var(--muted-foreground);
  font-size: 12.5px; line-height: 1.5; }
.usage-unpriced .copilotz-icon { margin-top: 2px; }

@container usage (max-width: 560px) {
  .usage-filters { flex-wrap: nowrap; }
  .usage-filters-gap { display: none; }
  .usage-period { flex: 1 1 0; min-width: 0; }
  .usage-whose-pick { flex: none; width: 122px; min-width: 0; }
  .usage-amount { font-size: 26px; }
  .usage-headline { font-size: 14px; }
  /* Each part of the sentence on its own line, without the dots that join them. */
  .usage-head .usage-dot { flex-basis: 100%; }
  .usage-head .usage-dot::before { content: none; }
  .usage-staff-line .usage-dot { flex-basis: auto; }
  .usage-staff-line .usage-dot::before { content: "·"; }
  .usage-item-details { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; }
  .usage-billing { margin-left: 0; padding-left: 0; flex-basis: 100%; }
  .usage-by-head .copilotz-tabs { width: 100%; }
  .usage-item-main { grid-template-columns: 28px minmax(0, 1fr) auto 28px; gap: 4px 10px; padding: 10px 6px 10px 12px; }
  .usage-item-when { grid-column: 2; grid-row: 2; }
  .usage-item-main > :is(.usage-face, .copilotz-avatar) { grid-row: 1 / span 2; align-self: start; }
  .usage-item-text { grid-column: 2; grid-row: 1; }
  .usage-item-main > .usage-price { grid-column: 3; grid-row: 1 / span 2; align-self: start; }
  .usage-item-main > :last-child { grid-column: 4; grid-row: 1 / span 2; align-self: start; }
  .usage-calls-box { margin: 0 10px 10px; }
}
`;
