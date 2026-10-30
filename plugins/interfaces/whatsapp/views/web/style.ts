/**
 * WhatsApp's front end, laid out on the theme's variables: a space's
 * WhatsApp tab (its number, linking your phone, where your messages go),
 * and connecting a number (what Meta gives, then its webhook). Only layout:
 * the pieces are the toolkit's.
 */
export const STYLE = `
.wa-tab { container: wa-tab / inline-size; display: grid; gap: 18px; }
.wa-tab-compact { gap: 14px; }
.wa-note { margin: 0; color: var(--muted-foreground); font-size: 13.5px; line-height: 1.55; }
.wa-note code, .wa-tips code { font-size: .92em; }

/* A number */
.wa-number { display: grid; overflow: hidden; }
.wa-number-head { display: flex; align-items: center; gap: 14px; padding: 16px 14px 16px 18px; min-width: 0; }
.wa-mark { display: grid; place-items: center; flex: none; width: 44px; height: 44px; border-radius: var(--radius-xl);
  background: var(--success-soft); color: var(--success-text); }
.wa-number-text { display: grid; gap: 2px; flex: 1; min-width: 0; }
.wa-number-phone { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; margin: 0;
  font-family: var(--font-display); font-size: 17px; font-weight: 650; letter-spacing: -.01em;
  font-variant-numeric: tabular-nums; }
.wa-number-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; margin: 0;
  color: var(--muted-foreground); font-size: 13px; }
.wa-number-meta .copilotz-time { font-size: 13px; }
.wa-problem { margin: 0 16px 14px; }
.wa-you { display: grid; gap: 14px; padding: 16px 18px 18px; border-top: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 28%, var(--card)); }
.wa-you-title { margin: 0; color: var(--muted-foreground); font-size: 11.5px; font-weight: 650; letter-spacing: .05em;
  text-transform: uppercase; }

/* Linking your phone */
.wa-offer { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.wa-offer-text { display: grid; gap: 2px; min-width: 0; }
.wa-offer-text b { font-size: 14.5px; font-weight: 620; }
.wa-steps { list-style: none; display: grid; gap: 18px; margin: 0; padding: 0; }
.wa-steps > li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 12px; }
.wa-step-number { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--primary-soft); color: var(--primary-text); font-size: 13px; font-weight: 700; }
.wa-step { display: grid; gap: 10px; min-width: 0; padding-top: 2px; }
.wa-step p { margin: 0; line-height: 1.55; }
.wa-code { display: inline-flex; align-items: center; gap: 6px; justify-self: start; padding: 8px 10px 8px 16px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); }
.wa-code-digits { font: 600 26px/1.2 var(--font-mono); letter-spacing: .12em; font-variant-numeric: tabular-nums; }
.wa-code[data-spent] .wa-code-digits { color: var(--muted-foreground); text-decoration: line-through; }
.wa-expiry { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; color: var(--muted-foreground);
  font-size: 13px; }
.wa-left { color: var(--foreground); font-variant-numeric: tabular-nums; }
.wa-waiting { display: flex; align-items: center; gap: 10px; color: var(--secondary-foreground); font-size: 13.5px; }
.wa-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }

/* Linked */
.wa-linked { display: grid; gap: 12px; }
.wa-linked-head { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; }
.wa-linked-head > .copilotz-icon { color: var(--success-text); }
.wa-linked-head b { font-weight: 620; }
.wa-linked-phone { color: var(--muted-foreground); font-size: 13.5px; font-variant-numeric: tabular-nums; }
.wa-where { display: grid; grid-template-columns: max-content minmax(0, 320px); align-items: center; gap: 12px; }
.wa-where label { font-size: 13.5px; font-weight: 560; }
.wa-tips { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.6; }

/* Connecting one */
.wa-form { display: grid; gap: 16px; }
.wa-need { display: grid; gap: 6px; margin: 0; padding-left: 20px; color: var(--secondary-foreground); font-size: 13.5px;
  line-height: 1.5; }
.wa-need code { font-size: .92em; }
.wa-hook { display: grid; gap: 14px; }
.wa-hook-field { display: grid; gap: 6px; }
.wa-hook-field > span { font-size: 13px; font-weight: 600; }
.wa-hook .copilotz-code-body { font-size: 13px; }

@container wa-tab (max-width: 560px) {
  .wa-offer { flex-direction: column; align-items: stretch; }
  .wa-where { grid-template-columns: minmax(0, 1fr); gap: 6px; }
  .wa-number-head { align-items: flex-start; }
}
`;
