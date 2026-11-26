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
.tier-card { display: grid; grid-template-rows: auto auto auto auto 1fr auto; gap: 10px; min-width: 0; padding: 16px 16px 14px;
  transition: border-color .15s, outline-color .15s; }
.tier-card[data-current] { border-color: var(--ring); outline: 1px solid var(--ring); outline-offset: -2px; }
.tier-card-top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 8px; min-height: 22px; }
.tier-card h3 { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 660; letter-spacing: -.012em; }
.tier-card-top .copilotz-badge { gap: 4px; }
.tier-card-for { margin: -4px 0 0; color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.45; }
.tier-card-price { display: flex; align-items: baseline; gap: 6px; margin: 0; color: var(--muted-foreground); font-size: 12.5px; }
.tier-card-price b { color: var(--foreground); font-family: var(--font-display); font-size: 21px; font-weight: 660;
  letter-spacing: -.015em; font-variant-numeric: tabular-nums; }
.tier-card-goes { margin: -6px 0 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.4; }
.tier-card-goes:empty { margin-top: -10px; }
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

.tier-card-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.tier-card-badges .copilotz-badge { gap: 4px; }
.tier-model small { display: block; }
.tier-new { display: grid; min-height: 160px; }
.tier-new-button { display: grid; place-content: center; justify-items: center; gap: 6px; padding: 18px; border: 1.5px dashed var(--border);
  border-radius: var(--radius-xl); background: transparent; color: var(--muted-foreground); font: inherit; text-align: center;
  cursor: pointer; transition: border-color .12s, color .12s; }
.tier-new-button:hover, .tier-new-button:focus-visible { border-color: var(--ring); color: var(--foreground); }
.tier-new-button b { color: var(--foreground); font-size: 15px; font-weight: 650; }
.tier-new-button span { max-width: 22ch; font-size: 12.5px; line-height: 1.45; }
.tiers-removed { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: -4px 0 0; color: var(--muted-foreground);
  font-size: 13px; }
.tiers-cap { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--secondary-foreground); font-size: 13.5px; }
.tiers-cap > .copilotz-select { width: auto; min-width: 160px; }
.tiers-cap span { color: var(--muted-foreground); font-size: 12.5px; }

/* Customizing a tier */
.tiers-editor { display: grid; gap: 16px; min-width: 0; }
.tiers-editor-names { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 12px; }
.tiers-editor-error { margin-inline-end: auto; align-self: center; color: var(--destructive-text, var(--destructive)); font-size: 13px; }
.tiers-kinds { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; }
.tiers-kind { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); }
.tiers-kind-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.tiers-kind-head b { font-size: 14.5px; font-weight: 650; }
.tiers-kind-head span { color: var(--muted-foreground); font-size: 12.5px; }
.tiers-chain { display: grid; gap: 6px; min-width: 0; }
.tiers-kind-new { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 10px; padding: 12px 14px;
  border: 1px dashed var(--border); border-radius: var(--radius-lg); }
.tiers-kind-new-end { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 6px; }
@container tiers (max-width: 520px) {
  .tiers-editor-names, .tiers-kind-new { grid-template-columns: minmax(0, 1fr); }
}

/* Beside the send button */
.tiers-pick { display: inline-flex; flex: 0 1 auto; min-width: 0; max-width: 100%; }
.tiers-pick .copilotz-button { min-width: 0; max-width: 100%; color: var(--muted-foreground); font-weight: 550; }
.tiers-pick .copilotz-button > svg, .tiers-pick .copilotz-button > .copilotz-icon { flex: none; }
/* Never wider than the row leaves it: the name shortens with an ellipsis, the send button stays. */
.tiers-pick-text { display: flex; min-width: 0; overflow: hidden; }
.tiers-pick-name, .tiers-pick-price { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiers-pick-name { flex: 0 1 auto; min-width: 2ch; }
.tiers-pick-price { flex: 0 100 auto; min-width: 0; }
/* A narrow composer (a phone, a side panel), by its own width (chat's \`chat-box\` container): the name only. */
@container chat-box (max-width: 520px) {
  .tiers-pick-price { display: none; }
}
.tiers-remove-said { margin: 0; color: var(--secondary-foreground); font-size: 14px; line-height: 1.5; }
.tiers-row-kind { display: inline-block; margin-right: 6px; padding: 0 6px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--secondary-foreground); font-size: 11.5px; font-weight: 600; }

/* Each agent's model */
.tiers-agents { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; padding: 16px 18px 8px; }
.tiers-agents-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 12px; }
.tiers-agents-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
.tiers-agents-head p { margin: 3px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
.tiers-agents-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.tiers-rows { display: grid; margin: 6px 0 0; padding: 0; list-style: none; }
.tiers-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 11px 0; }
.tiers-row + .tiers-row { border-top: 1px solid var(--border); }
.tiers-row-text { display: grid; gap: 2px; min-width: 0; }
.tiers-row-name { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; margin: 0; font-size: 14px; font-weight: 620; }
.tiers-row-handle { color: var(--muted-foreground); font-family: var(--font-mono); font-size: 12px; font-weight: 450; }
.tiers-row-about { margin: 0; overflow: hidden; color: var(--muted-foreground); font-size: 13px; line-height: 1.45;
  text-overflow: ellipsis; white-space: nowrap; }
.tiers-row-end { display: flex; align-items: center; gap: 6px; }
.tiers-off { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; margin: 4px 0 8px; padding-top: 12px; border-top: 1px solid var(--border); }
.tiers-off h4 { margin: 0; color: var(--muted-foreground); font-size: 12px; font-weight: 650; letter-spacing: .05em;
  text-transform: uppercase; }
.tiers-off-row { display: flex; align-items: center; gap: 10px; min-width: 0; color: var(--secondary-foreground); font-size: 13.5px; }
.tiers-off-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tiers-row-model { margin: 0; color: var(--secondary-foreground); font-size: 13px; line-height: 1.45; }
.tiers-row-model b { color: var(--foreground); font-weight: 600; }
.tiers-row-from[data-picked] { color: var(--primary-text); }
.tiers-row-price { color: var(--muted-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tiers-row[data-editing] { grid-template-columns: 32px minmax(0, 1fr) auto; align-items: start; }
.tiers-row[data-editing] > .copilotz-avatar { margin-top: 2px; }
.tiers-row-pick { display: grid; gap: 6px; min-width: 0; }
.tiers-row-under { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; color: var(--muted-foreground); font-size: 12.5px; }
.tiers-back { height: auto; padding: 0; font-size: 12.5px; }
.tiers-row-then { margin: 1px 0 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.tiers-fallbacks { display: grid; gap: 4px; margin-top: 6px; padding: 8px 10px; border: 1px dashed var(--border);
  border-radius: var(--radius-md); }
.tiers-fallbacks-head { margin: 0; color: var(--secondary-foreground); font-size: 12.5px; font-weight: 600; }
.tiers-fallbacks-head span { color: var(--muted-foreground); font-weight: 450; }
.tiers-fallbacks-list { display: grid; gap: 2px; margin: 0; padding: 0 0 0 18px; font-size: 13px; }
.tiers-fallbacks-list li { padding-left: 2px; }
.tiers-fallback-name { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; margin-right: 4px; }
.tiers-fallback-name b { font-weight: 600; }
.tiers-fallback-name small { color: var(--muted-foreground); font-size: 12px; }
.tiers-fallbacks-none { margin: 0; color: var(--muted-foreground); font-size: 12.5px; }

.tiers-foot { display: flex; align-items: flex-start; gap: 7px; margin: 0 2px; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.5; }
.tiers-foot .copilotz-icon { flex: none; margin-top: 2px; }
.tiers-foot a { color: var(--primary-text); text-underline-offset: 3px; }

/* Choosing a tier when the org is new: one choice, a row each */
.tiers-setup { container: tiers-setup / inline-size; display: grid; gap: 12px; min-width: 0; }
.tiers-options { display: grid; gap: 8px; }
.tiers-option { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: start; gap: 12px; width: 100%;
  padding: 13px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card);
  color: inherit; font: inherit; text-align: left; cursor: pointer; transition: border-color .12s, background-color .12s; }
.tiers-option:hover { border-color: var(--ring); }
.tiers-option:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.tiers-option[data-checked] { border-color: var(--ring); outline: 1px solid var(--ring); outline-offset: -2px;
  background: color-mix(in oklab, var(--primary-soft) 40%, var(--card)); }
.tiers-option[aria-disabled] { cursor: default; }
.tiers-option-mark { display: grid; place-items: center; width: 20px; height: 20px; margin-top: 1px; border: 1.5px solid var(--input);
  border-radius: var(--radius-full); color: var(--primary-foreground); }
.tiers-option[data-checked] .tiers-option-mark { border-color: var(--primary); background: var(--primary); }
.tiers-option[aria-busy] .tiers-option-mark { border-color: transparent; color: var(--primary-text); }
.tiers-option-text { display: grid; gap: 3px; min-width: 0; }
.tiers-option-name { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-family: var(--font-display);
  font-size: 15.5px; font-weight: 650; letter-spacing: -.01em; }
.tiers-option-for { color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.45; }
.tiers-option-goes { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.tiers-option-price { display: grid; justify-items: end; gap: 1px; min-width: 76px; color: var(--muted-foreground); font-size: 12px;
  white-space: nowrap; }
.tiers-option-price b { color: var(--foreground); font-family: var(--font-display); font-size: 19px; font-weight: 660;
  letter-spacing: -.015em; font-variant-numeric: tabular-nums; }
.tiers-option-meter { display: block; width: 64px; height: 4px; margin-top: 6px; border-radius: var(--radius-full);
  background: var(--muted); overflow: hidden; }
.tiers-option-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--primary); }
@container tiers-setup (max-width: 420px) {
  .tiers-option { grid-template-columns: 22px minmax(0, 1fr); }
  .tiers-option-price { grid-column: 2; justify-items: start; }
}

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
