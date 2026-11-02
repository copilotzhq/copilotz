/**
 * Billing's layout on the web, on the theme's variables: the balance first (the
 * big number, and what it's made of as one bar and a list), pairs of cards that
 * stack where there's no room, the amounts to choose from, the budget's meter,
 * the history's rows, staff's panel in the warning colour as the shell marks
 * staff, and the note above where you type. Only layout and those marks: the
 * pieces are the toolkit's.
 */
export const STYLE = `
.billing { container: billing / inline-size; display: grid; gap: 16px; min-width: 0; }
.billing-label { margin: 0; color: var(--muted-foreground); font-family: inherit; font-size: 12.5px; font-weight: 600; }
.billing-text { margin: 0; color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.5; }
.billing-small { display: flex; align-items: flex-start; gap: 6px; margin: 0; color: var(--muted-foreground);
  font-size: 12.5px; line-height: 1.45; }
.billing-small .copilotz-icon { flex: none; margin-top: 2px; }

/* An org with nothing to worry about */
.billing-calm { display: flex; align-items: flex-start; gap: 12px; padding: 18px 20px; }
.billing-calm h3 { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.billing-calm p { margin: 3px 0 0; color: var(--secondary-foreground); font-size: 14px; line-height: 1.5; }
.billing-calm-icon { flex: none; display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-lg);
  background: var(--success-soft); color: var(--success-text); }

/* The balance */
.billing-balance { display: grid; gap: 16px; padding: 20px 22px; }
.billing-standing { margin: -4px -6px 2px; }
.billing-balance-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 16px 36px; align-items: start; }
.billing-balance-main { display: grid; gap: 2px; min-width: 0; }
.billing-amount { margin: 2px 0 0; font-family: var(--font-display); font-size: clamp(34px, 8.5cqi, 50px); font-weight: 680;
  letter-spacing: -.03em; line-height: 1.08; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.billing-debt { margin: 6px 0 0; color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.45; }
.billing-worth { margin: 8px 0 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.billing-buckets { display: grid; gap: 10px; min-width: 0; }
.billing-buckets h4 { font-size: 12.5px; }
.billing-stack { display: flex; gap: 2px; height: 8px; border-radius: var(--radius-sm); overflow: hidden; }
.billing-stack > span { flex-basis: 0; min-width: 3px; }
[data-colour="1"] { background: var(--chart-1, var(--primary)); }
[data-colour="2"] { background: var(--chart-2, var(--primary)); }
[data-colour="3"] { background: var(--chart-3, var(--success)); }
[data-colour="4"] { background: var(--chart-4, var(--warning)); }
[data-colour="5"] { background: var(--chart-5, var(--primary)); }
.billing-bucket-list { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
.billing-bucket-list li { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; align-items: baseline; gap: 10px;
  padding: 5px 0; }
.billing-bucket-list li + li { border-top: 1px solid var(--border); }
.billing-bucket-list i { align-self: center; width: 10px; height: 10px; border-radius: var(--radius-sm); }
.billing-bucket-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; min-width: 0; font-size: 14px; font-weight: 580; }
.billing-bucket-name small { color: var(--muted-foreground); font-size: 12.5px; font-weight: 450; }
.billing-bucket-left { display: inline-flex; flex-wrap: wrap; align-items: baseline; justify-content: flex-end; gap: 0 6px;
  font-size: 14px; font-weight: 620; font-variant-numeric: tabular-nums; text-align: right; }
.billing-bucket-left small { color: var(--muted-foreground); font-size: 12px; font-weight: 450; }

/* A payment being confirmed */
.billing-paying-line { display: flex; align-items: flex-start; gap: 10px; }
.billing-paying-line > :first-child { flex: none; margin-top: 2px; }
.billing-paying b { font-weight: 650; }

/* Cards, in pairs where there's room */
.billing-pair { display: grid; grid-template-columns: minmax(0, 1.45fr) minmax(0, 1fr); gap: 16px; }
.billing-pair[data-single] { grid-template-columns: minmax(0, 1fr); }
.billing-pair-even { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.billing-card { display: grid; align-content: start; gap: 12px; min-width: 0; padding: 18px 20px; scroll-margin: 24px; }
.billing-card-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; min-height: 22px; }
.billing-card-head h3 { margin: 0; font-size: 15px; font-weight: 650; }
.billing-card-end { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 2px; }
.billing-card-end .billing-small { flex: 1 1 140px; }
.billing-facts { display: grid; gap: 8px; margin: 0; }
.billing-facts > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 2px 10px; align-items: baseline; }
.billing-facts dt { color: var(--muted-foreground); font-size: 13px; }
.billing-facts dd { margin: 0; font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.billing-facts small { margin-left: 5px; color: var(--muted-foreground); font-size: 12.5px; }

/* Adding credits */
.billing-add { display: grid; gap: 12px; }
.billing-choices { display: flex; flex-wrap: wrap; gap: 6px; }
.billing-choice { position: relative; flex: 1 1 54px; display: grid; place-items: center; min-height: 46px; padding: 0 4px; border: 1px solid var(--input);
  border-radius: var(--radius-lg); background: var(--card); color: var(--foreground); cursor: pointer; font-size: 15px; font-weight: 620;
  font-variant-numeric: tabular-nums; transition: background-color .12s, border-color .12s, box-shadow .12s; }
.billing-choice:hover { background: var(--muted); }
.billing-choice[data-on] { border-color: var(--ring); background: var(--primary-soft); color: var(--primary-text);
  outline: 1px solid var(--ring); outline-offset: -2px; }
.billing-choice input { position: absolute; inset: 0; margin: 0; appearance: none; border-radius: inherit; cursor: inherit; outline: none; }
.billing-choice input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.billing-choice:has(input:disabled) { opacity: .6; cursor: default; }
.billing-money-input::before { content: "$"; color: var(--muted-foreground); font-size: 14.5px; }
.billing-after { margin: 0; min-height: 1.45em; color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.45; }
.billing-after b { color: var(--foreground); font-weight: 650; font-variant-numeric: tabular-nums; }
.billing-go { width: 100%; }
.billing-pair[data-single] .billing-redeem { max-width: 480px; }
.billing-redeem { display: grid; gap: 10px; justify-items: start; }
.billing-redeem > * { width: 100%; }
.billing-redeem > .billing-go-small { width: auto; }
.billing-code-input input { font-family: var(--font-mono); font-size: 13.5px; letter-spacing: .01em; }

/* The plan */
.billing-plan-name { margin: -6px 0 0; font-family: var(--font-display); font-size: 22px; font-weight: 660; letter-spacing: -.015em; line-height: 1.2; }
.billing-offers { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 0; padding: 0; list-style: none; }
.billing-offer { display: grid; grid-template-rows: 1fr auto; gap: 12px; min-width: 0; padding: 14px 16px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); }
.billing-offer-text { display: grid; align-content: start; gap: 1px; min-width: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.45; }
.billing-offer-text b { color: var(--foreground); font-family: var(--font-display); font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.billing-offer-total { margin-bottom: 4px; color: var(--foreground); font-size: 14.5px; font-weight: 620; font-variant-numeric: tabular-nums; }

/* The month's budget */
.billing-spent { margin: -4px 0 0; color: var(--muted-foreground); font-size: 15px; font-variant-numeric: tabular-nums; }
.billing-spent b { color: var(--foreground); font-family: var(--font-display); font-size: 22px; font-weight: 660; letter-spacing: -.015em; }
.billing-meter { height: 8px; border-radius: var(--radius-sm); overflow: hidden;
  background: color-mix(in oklab, var(--chart-1, var(--primary)) 14%, transparent); }
.billing-meter > span { display: block; height: 100%; border-radius: var(--radius-sm); background: var(--chart-1, var(--primary));
  transition: width .3s ease-out; }
.billing-meter[data-tone=near] { background: color-mix(in oklab, var(--warning) 20%, transparent); }
.billing-meter[data-tone=near] > span { background: var(--warning); }
.billing-meter[data-tone=at] { background: color-mix(in oklab, var(--warning) 20%, transparent); }
.billing-meter[data-tone=at] > span { background: var(--warning); border-radius: 0; }

/* Dialogs */
.billing-dialog { display: grid; gap: 14px; min-width: 0; }
.billing-dialog > .copilotz-tabs { justify-self: start; }
.billing-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px; align-items: start; }
.billing-rules { display: grid; gap: 6px; margin: 0; padding: 12px 14px; border-radius: var(--radius-lg); background: var(--muted);
  list-style: none; color: var(--secondary-foreground); font-size: 13.5px; line-height: 1.4; }
.billing-rules li { display: flex; align-items: flex-start; gap: 8px; }
.billing-rules .copilotz-icon { flex: none; margin-top: 2px; color: var(--muted-foreground); }
.billing-people { display: grid; gap: 6px; margin: 0; padding: 0; border: 0; min-width: 0; }
.billing-people legend { margin-bottom: 6px; padding: 0; font-size: 13.5px; font-weight: 600; }

/* History */
.billing-history { gap: 6px; }
.billing-history-head { margin-bottom: 6px; }
.billing-rows { display: grid; margin: 0 -4px; padding: 0; list-style: none; }
.billing-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 16px; padding: 9px 4px; }
.billing-row + .billing-row { border-top: 1px solid var(--border); }
.billing-row-text { display: grid; gap: 1px; min-width: 0; font-size: 14px; line-height: 1.4; }
.billing-row-text b { font-weight: 600; }
.billing-row-note { color: var(--muted-foreground); font-size: 13px; overflow-wrap: anywhere; }
.billing-row-end { display: grid; justify-items: end; gap: 1px; line-height: 1.4; }
.billing-row-end small { color: var(--muted-foreground); font-size: 12.5px; white-space: nowrap; }
.billing-row-staff { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 5px; margin-top: 1px; font-size: 11.5px;
  color: color-mix(in oklab, var(--warning-text) 80%, var(--muted-foreground)); overflow-wrap: anywhere; }
.billing-row-amount { font-size: 14.5px; font-weight: 640; font-variant-numeric: tabular-nums; white-space: nowrap; }
.billing-row-amount[data-way=in] { color: var(--success-text); }
.billing-row-amount[data-way=out] { color: var(--secondary-foreground); }
.billing-none { padding: 22px 12px 16px; }
.billing-none .copilotz-empty-icon { width: 44px; height: 44px; margin-bottom: 4px; }
.billing-none .copilotz-empty-title { font-size: 16px; }
.billing-none .copilotz-empty-text { font-size: 13.5px; }
.billing-more { justify-self: start; margin: 4px 0 -6px -8px; }

/* Staff only */
.billing-staff { display: grid; gap: 12px; padding: 12px 14px 14px; border: 1px solid var(--warning-border);
  border-radius: var(--radius-lg); background: var(--warning-soft); }
.billing-staff-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--secondary-foreground);
  font-size: 12.5px; line-height: 1.4; }
.billing-staff-head .copilotz-badge { gap: 4px; }
.billing-staff-now { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--warning-border);
  border-radius: var(--radius-md); background: var(--card); }
.billing-waiver { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 10px;
  border-top: 1px solid var(--border); font-size: 14px; }
.billing-waiver b { font-weight: 620; }
.billing-waiver p { margin: 1px 0 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
.billing-waiver .copilotz-button { flex: none; }
.billing-staff-actions { display: flex; flex-wrap: wrap; gap: 8px; }

/* Above where you type */
.billing-note { align-items: center; padding: 6px 8px 6px 12px; font-size: 13.5px; }
.billing-note > .copilotz-icon { margin-top: 0; }
.billing-note .copilotz-notice-action { margin: 0; }
.billing-note .copilotz-notice-text b { color: var(--foreground); font-weight: 620; }

@container billing (max-width: 720px) {
  .billing-pair, .billing-pair-even { grid-template-columns: minmax(0, 1fr); }
  .billing-pair[data-budget-first] > :first-child { order: 1; }
  .billing-balance-grid { grid-template-columns: minmax(0, 1fr); }
}
@container billing (max-width: 520px) {
  .billing-balance, .billing-card { padding: 16px; }
  .billing-standing { margin: -2px -2px 0; }
  .billing-wrap { flex-wrap: wrap; }
  .billing-wrap .copilotz-notice-body { flex: 1 1 calc(100% - 30px); }
  .billing-wrap .copilotz-notice-action { flex: 1 1 100%; margin: 2px 0 0; }
  .billing-wrap .copilotz-notice-action > .copilotz-button { flex: 1; }
  .billing-two { grid-template-columns: minmax(0, 1fr); }
  .billing-staff-actions > .copilotz-button { flex: 1 1 calc(50% - 4px); padding: 0 8px; }
  .billing-waiver { align-items: flex-start; }
}
`;
