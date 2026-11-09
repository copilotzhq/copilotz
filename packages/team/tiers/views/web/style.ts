/**
 * Tiers' layout on the web, on the theme's variables: the org's tiers as
 * cards side by side where there's room (the one in use outlined), each
 * agent's model in rows, the line a space's agents get, and the space's own
 * choice above them. Only layout: the pieces are the toolkit's.
 */
export const STYLE = `
.tiers { container: tiers / inline-size; display: grid; gap: 16px; min-width: 0; }
.tiers-now { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 16px; }
.tiers-now p { margin: 0; color: var(--secondary-foreground); font-size: 14.5px; line-height: 1.5; }
.tiers-now b { color: var(--foreground); font-weight: 650; }
.tiers-now .copilotz-button { flex: none; }

/* The tiers, as cards */
.tiers-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(214px, 1fr)); gap: 12px; margin: 0; padding: 0;
  list-style: none; }
.tier-card { display: grid; grid-template-rows: auto auto auto 1fr auto; gap: 10px; min-width: 0; padding: 16px 16px 14px;
  transition: border-color .15s, outline-color .15s; }
.tier-card[data-current] { border-color: var(--ring); outline: 1px solid var(--ring); outline-offset: -2px; }
.tier-card-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; min-height: 22px; }
.tier-card h3 { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 660; letter-spacing: -.012em; }
.tier-card-top .copilotz-badge { gap: 4px; }
.tier-card-for { margin: -4px 0 0; color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.45; }
.tier-card-price { display: flex; align-items: baseline; gap: 6px; margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.tier-card-price b { color: var(--foreground); font-family: var(--font-display); font-size: 21px; font-weight: 660;
  letter-spacing: -.015em; font-variant-numeric: tabular-nums; }
.tier-card-agents { display: grid; align-content: start; gap: 7px; margin: 0; padding: 10px 0 2px; border-top: 1px solid var(--border);
  list-style: none; }
.tier-card-agents li { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 8px; align-items: baseline; font-size: 13px;
  line-height: 1.35; }
.tier-who { display: flex; align-items: baseline; gap: 5px; min-width: 0; overflow: hidden; color: var(--muted-foreground);
  white-space: nowrap; text-overflow: ellipsis; }
.tier-model { display: grid; min-width: 0; color: var(--foreground); font-weight: 560; overflow-wrap: anywhere; }
.tier-model small { color: var(--muted-foreground); font-size: 12px; font-weight: 450; }
.tier-card-end { display: grid; margin-top: 2px; }
.tier-card-using { display: flex; align-items: center; justify-content: center; gap: 6px; height: 36px; margin: 0;
  border-radius: var(--radius-md); background: var(--primary-soft); color: var(--primary-text); font-size: 13.5px; font-weight: 600; }

/* Each agent's model */
.tiers-agents { display: grid; gap: 2px; padding: 16px 18px 8px; }
.tiers-agents-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
.tiers-agents-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
.tiers-agents-head p { margin: 3px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
.tiers-agents-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.tiers-rows { display: grid; margin: 6px 0 0; padding: 0; list-style: none; }
.tiers-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 11px 0; }
.tiers-row + .tiers-row { border-top: 1px solid var(--border); }
.tiers-row-text { display: grid; gap: 2px; min-width: 0; }
.tiers-row-name { margin: 0; font-size: 14px; font-weight: 620; }
.tiers-row-model { margin: 0; color: var(--secondary-foreground); font-size: 13px; line-height: 1.45; }
.tiers-row-model b { color: var(--foreground); font-weight: 600; }
.tiers-row-from[data-picked] { color: var(--primary-text); }
.tiers-row-price { color: var(--muted-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tiers-row[data-editing] { grid-template-columns: 32px minmax(0, 1fr); align-items: start; }
.tiers-row[data-editing] > .copilotz-avatar { margin-top: 2px; }
.tiers-row-pick { display: grid; gap: 6px; min-width: 0; }
.tiers-row-under { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; color: var(--muted-foreground); font-size: 12.5px; }
.tiers-back { height: auto; padding: 0; font-size: 12.5px; }

.tiers-foot { display: flex; align-items: flex-start; gap: 7px; margin: 0 2px; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.5; }
.tiers-foot .copilotz-icon { flex: none; margin-top: 2px; }
.tiers-foot a { color: var(--primary-text); text-underline-offset: 3px; }

/* A space's agents: its choice, and each one's line */
.tiers-space { container: tiers-space / inline-size; display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px;
  padding: 12px 12px 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
.tiers-space-mark { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-md);
  background: var(--primary-soft); color: var(--primary-text); }
.tiers-space-text { flex: 1 1 200px; display: grid; gap: 1px; min-width: 0; }
.tiers-space-text b { font-size: 14px; font-weight: 620; }
.tiers-space-text span { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.tiers-space > .copilotz-select { flex: 1 1 210px; max-width: 280px; }
.tiers-space-error { flex-basis: 100%; margin: 0; color: var(--destructive-text, var(--destructive)); font-size: 12.5px; }
.tiers-line { min-width: 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.tiers-line b { color: var(--secondary-foreground); font-weight: 600; }
.tiers-line[data-picked] .tiers-line-from { color: var(--primary-text); }

@container tiers-space (max-width: 480px) {
  .tiers-space > .copilotz-select { flex-basis: 100%; max-width: none; }
}
@container tiers (max-width: 520px) {
  .tiers-agents { padding: 14px 14px 6px; }
  .tiers-row { grid-template-columns: 32px minmax(0, 1fr); align-items: start; }
  .tiers-row > .copilotz-avatar { margin-top: 2px; }
  .tiers-row-price { grid-column: 2; }
}
`;
