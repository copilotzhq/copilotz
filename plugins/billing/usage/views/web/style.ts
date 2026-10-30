/**
 * Usage's layout on the web, on the theme's variables: the filters in one
 * row, the headline numbers, the day-by-day chart (its columns in the
 * theme's first chart colour, hairline grid, its tooltip, its table), the
 * groups with their share bars, and the latest calls. Only layout and the
 * chart's marks: the pieces are the toolkit's.
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
.usage-day path { fill: var(--chart-1, var(--primary)); transition: opacity .12s; }
.usage-chart-plot svg:has(.usage-day[data-on]) .usage-day:not([data-on]) path { opacity: .45; }
.usage-hit { fill: transparent; cursor: default; }
.usage-tip { position: absolute; z-index: 3; display: grid; gap: 1px; min-width: 150px; padding: 8px 11px;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-md); font-size: 12px; line-height: 1.4;
  pointer-events: none; transform: translate(-50%, -100%); white-space: nowrap; }
.usage-tip-day { color: var(--muted-foreground); }
.usage-tip-value { font-size: 16px; font-weight: 700; font-variant-numeric: tabular-nums; }
.usage-tip-rest { color: var(--secondary-foreground); font-variant-numeric: tabular-nums; }
.usage-chart-foot { display: flex; justify-content: flex-end; margin: -2px -6px -6px 0; }
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

/* The latest calls */
.usage-recent { gap: 0; overflow: hidden; }
.usage-recent-head { padding: 14px 16px 10px; }
.usage-recent-scroll { overflow-x: auto; }
.usage-calls td { color: var(--secondary-foreground); }
.usage-calls td:first-child, .usage-calls th:first-child { padding-left: 16px; }
.usage-calls td:last-child, .usage-calls th:last-child { padding-right: 16px; }
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
}
`;
