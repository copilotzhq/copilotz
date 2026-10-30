/**
 * Usage's layout on the web, on the theme's variables: the filters in one
 * row, the headline numbers, staff's cost and margin (in the warning
 * colour, as the shell marks staff), the day-by-day chart (its columns in
 * the theme's first chart colour, the input read from a cache in its third,
 * hairline grid, its tooltip, its table), the groups with their share bars,
 * caching (the input's parts as one bar: from cache, written to it,
 * neither) and the latest calls. Only layout and the charts' marks: the
 * pieces are the toolkit's.
 */
export const STYLE = `
.usage { container: usage / inline-size; display: grid; gap: 16px; }
.usage[data-loading] .usage-tiles, .usage[data-loading] .usage-card { opacity: .62; transition: opacity .2s; }
.usage-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.usage-filters-gap { flex: 1; }
.usage-filters-end { display: flex; align-items: center; gap: 6px; }
.usage-period { min-width: 150px; }
.usage-whose { display: flex; align-items: center; gap: 7px; margin: -4px 2px 0; color: var(--muted-foreground);
  font-size: 13px; }

/* The headline numbers */
.usage-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.usage-tile { display: grid; align-content: start; gap: 3px; min-width: 0; padding: 14px 16px 13px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
.usage-tile-label { color: var(--muted-foreground); font-size: 12.5px; font-weight: 600; }
.usage-tile-value { font-family: var(--font-sans); font-size: 26px; font-weight: 680; letter-spacing: -.02em;
  line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-tile-note { display: grid; gap: 1px; min-width: 0; color: var(--muted-foreground); font-size: 12px; line-height: 1.4; }
.usage-delta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 5px; color: var(--secondary-foreground);
  font-weight: 620; font-variant-numeric: tabular-nums; }
.usage-delta-against { color: var(--muted-foreground); font-weight: 450; }
.usage-tile-more { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Staff only: what it cost, and the margin */
.usage-staff { display: grid; gap: 10px; padding: 10px 12px 12px; border: 1px solid var(--warning-border);
  border-radius: var(--radius-lg); background: var(--warning-soft); }
.usage-staff-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--secondary-foreground);
  font-size: 12.5px; line-height: 1.4; }
.usage-staff-head .copilotz-badge { gap: 4px; }
.usage-staff-tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.usage-tile-staff { padding: 11px 14px 10px; border-color: var(--warning-border); }
.usage-tile-staff .usage-tile-value { font-size: 21px; }
.usage-staff-col { background: var(--warning-soft); }
.usage-table thead th.usage-staff-col { background: var(--warning-soft); }
.usage-staff-th { display: inline-flex; align-items: center; gap: 4px; color: var(--warning-text); }
.usage-row-staff { display: flex; align-items: center; gap: 4px; min-width: 0;
  color: color-mix(in oklab, var(--warning-text) 80%, var(--muted-foreground)); font-size: 11.5px; font-weight: 450;
  overflow: hidden; white-space: nowrap; font-variant-numeric: tabular-nums; }

/* Cards */
.usage-card { display: grid; gap: 12px; min-width: 0; }
.usage-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.usage-card-head h3 { margin: 0; font-size: 14.5px; font-weight: 650; }
.usage-card-head p { margin: 0; color: var(--muted-foreground); font-size: 13px; font-variant-numeric: tabular-nums; }
.usage-card-head p b { color: var(--foreground); font-weight: 650; }
.usage-empty { padding: 28px 16px; }

/* The day-by-day chart */
.usage-chart { display: grid; gap: 4px; }
.usage-chart-plot { position: relative; min-width: 0; }
.usage-chart-plot svg { display: block; overflow: visible; border-radius: var(--radius-sm); }
.usage-chart-plot svg:focus-visible { outline: 2px solid var(--ring); outline-offset: 4px; }
.usage-tick line { stroke: var(--border); stroke-width: 1; shape-rendering: crispEdges; }
.usage-tick text, .usage-axis { fill: var(--muted-foreground); font-size: 11px; font-variant-numeric: tabular-nums; }
.usage-day path, .usage-day .usage-cached { fill: var(--chart-1, var(--primary)); transition: opacity .12s; }
.usage-day .usage-cached { fill: var(--chart-3, var(--success)); }
.usage-chart-plot svg:has(.usage-day[data-on]) .usage-day:not([data-on]) :is(path, .usage-cached) { opacity: .45; }
.usage-hit { fill: transparent; cursor: default; }
.usage-tip { position: absolute; z-index: 3; display: grid; gap: 1px; min-width: 150px; padding: 8px 11px;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-md); font-size: 12px; line-height: 1.4;
  pointer-events: none; transform: translate(-50%, -100%); white-space: nowrap; }
.usage-tip-day { color: var(--muted-foreground); }
.usage-tip-value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.usage-tip-rest { color: var(--secondary-foreground); font-variant-numeric: tabular-nums; }
.usage-tip-cache { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.usage-chart-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 12px;
  margin: -2px -6px -6px 0; }
.usage-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 auto 0 0; padding: 0; list-style: none;
  color: var(--secondary-foreground); font-size: 12px; }
.usage-legend li { display: inline-flex; align-items: center; gap: 6px; }

/* What a colour stands for: input read from a cache, written to one, neither (and other tokens) */
.usage-key { display: inline-block; flex: none; width: 10px; height: 10px; border-radius: var(--radius-sm);
  background: var(--chart-1, var(--primary)); }
.usage-c-cached, .usage-key-cached { background: var(--chart-3, var(--success)); }
.usage-c-written { background: var(--chart-4, var(--warning)); }
.usage-c-fresh { background: var(--chart-1, var(--primary)); }
.usage-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.usage-table-box { max-height: 320px; overflow: auto; border-top: 1px solid var(--border); }

/* Tables: the chart's numbers, and the latest calls */
.usage-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.usage-table th, .usage-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left;
  white-space: nowrap; }
.usage-table thead th { position: sticky; top: 0; background: var(--card); color: var(--muted-foreground);
  font-size: 11.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; }
.usage-table tbody th { font-weight: 500; }
.usage-table tbody tr:last-child > * { border-bottom: 0; }
.usage-num { text-align: right !important; font-variant-numeric: tabular-nums; }
.usage-quiet { color: var(--muted-foreground); }

/* By person, agent and model */
.usage-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; align-items: start; }
.usage-rows { list-style: none; display: grid; gap: 4px; margin: 0; padding: 0; }
.usage-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 6px 2px; }
.usage-row-text { display: grid; gap: 4px; min-width: 0; }
.usage-row-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; overflow: hidden; font-size: 13.5px;
  font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.usage-row-detail { color: var(--muted-foreground); font-size: 12px; font-weight: 450; }
.usage-row-meter { display: block; height: 4px; border-radius: var(--radius-full);
  background: color-mix(in oklab, var(--chart-1, var(--primary)) 14%, transparent); overflow: hidden; }
.usage-row-meter > span { display: block; height: 100%; border-radius: var(--radius-full);
  background: var(--chart-1, var(--primary)); }
.usage-row-rest { color: var(--muted-foreground); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-variant-numeric: tabular-nums; }
.usage-row-value { display: grid; justify-items: end; font-size: 13.5px; font-weight: 650; font-variant-numeric: tabular-nums; }
.usage-row-share { color: var(--muted-foreground); font-size: 11.5px; font-weight: 500; }
.usage-face-none, .usage-face-model { display: grid; place-items: center; width: 26px; height: 26px;
  border-radius: var(--radius-full); background: var(--muted); color: var(--muted-foreground); }
.usage-face-model { border-radius: var(--radius-sm); background: var(--primary-soft); color: var(--primary-text); }
.usage-more { justify-self: start; margin: -4px 0 -6px -8px; }

/* Caching */
.usage-lede { margin: -6px 0 0; max-width: 72ch; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.usage-cache-none { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 12px 14px;
  border-radius: var(--radius-lg); background: var(--muted); color: var(--secondary-foreground); font-size: 13px;
  line-height: 1.5; }
.usage-cache-none .copilotz-icon { flex: none; margin-top: 3px; }
.usage-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border: 1px solid var(--border);
  border-radius: var(--radius-lg); }
.usage-stat { display: grid; align-content: start; gap: 2px; min-width: 0; padding: 10px 14px 11px; }
.usage-stat + .usage-stat { border-left: 1px solid var(--border); }
.usage-stat-label { color: var(--muted-foreground); font-size: 12px; font-weight: 600; }
.usage-stat-value { font-size: 20px; font-weight: 680; letter-spacing: -.015em; line-height: 1.25; }
.usage-stat-note { color: var(--muted-foreground); font-size: 12px; line-height: 1.4; }
.usage-split { display: grid; gap: 12px; padding-top: 2px; }
.usage-split-bar { display: flex; gap: 2px; height: 10px; border-radius: var(--radius-sm); overflow: hidden; }
.usage-split-bar > span { flex-basis: 0; min-width: 3px; }
.usage-split-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 16px; margin: 0;
  padding: 0; list-style: none; }
.usage-split-legend li { display: grid; grid-template-columns: 10px minmax(0, 1fr); align-items: center; gap: 1px 8px;
  min-width: 0; }
.usage-legend-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.usage-legend-name .usage-quiet { font-weight: 500; font-variant-numeric: tabular-nums; }
.usage-legend-num { grid-column: 2; color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
.usage-cache-models { margin: 0 -16px -14px; border-top: 1px solid var(--border); }
.usage-cache-models tbody th { font-weight: 500; }
.usage-hit { display: inline-grid; grid-template-columns: 52px auto; align-items: center; gap: 8px;
  font-variant-numeric: tabular-nums; }
.usage-meter { display: block; height: 4px; border-radius: var(--radius-full); overflow: hidden;
  background: color-mix(in oklab, var(--chart-3, var(--success)) 16%, transparent); }
.usage-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--chart-3, var(--success)); }
.usage-two { display: inline-grid; justify-items: end; line-height: 1.3; }
.usage-two small { color: var(--muted-foreground); font-size: 11.5px; }
.usage-more-wide { margin: 4px 0 8px 8px; }

/* Wide tables: they scroll sideways where they don't fit */
.usage-wide { overflow-x: auto; }
.usage-wide .usage-table :is(td, th):first-child { padding-left: 16px; }
.usage-wide .usage-table :is(td, th):last-child { padding-right: 16px; }

/* The latest calls */
.usage-recent { gap: 0; overflow: hidden; }
.usage-recent-head { padding: 14px 16px 10px; }
.usage-recent-whose { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 8px; }
.usage-calls td { color: var(--secondary-foreground); }
.usage-th-hint { text-decoration: underline dotted; text-underline-offset: 3px; cursor: help; }
.usage-cached-cell { display: inline-flex; align-items: baseline; gap: 4px; }
.usage-wrote { color: var(--muted-foreground); font-size: 11.5px; }
.usage-when .copilotz-time { font-size: 12.5px; }
.usage-who { display: inline-flex; align-items: center; gap: 7px; color: var(--foreground); }
.usage-model { display: inline-flex; align-items: baseline; gap: 6px; color: var(--foreground); font-weight: 520; }
.usage-unpriced { display: flex; align-items: flex-start; gap: 7px; margin: 0 2px; color: var(--muted-foreground);
  font-size: 12.5px; line-height: 1.5; }
.usage-unpriced .copilotz-icon { margin-top: 2px; }

@container usage (max-width: 760px) {
  .usage-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .usage-tile-value { font-size: 22px; }
}
@container usage (max-width: 560px) {
  .usage-filters-gap { display: none; }
  .usage-period { flex: 1; min-width: 0; }
  .usage-filters-end { width: 100%; justify-content: space-between; }
  .usage-tile { padding: 12px 13px 11px; }
  .usage-staff-tiles, .usage-stats, .usage-split-legend { grid-template-columns: minmax(0, 1fr); }
  .usage-staff-tiles { gap: 8px; }
  .usage-stat + .usage-stat { border-left: 0; border-top: 1px solid var(--border); }
  .usage-tile-more { white-space: normal; }
}
`;
