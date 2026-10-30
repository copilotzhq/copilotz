/**
 * The API's front end, laid out on the theme's variables: a space's API tab
 * (its intro, the person's keys, trying it), making a key (presets, a
 * custom pick, the secret shown once) and a key's reference. Only layout:
 * the pieces are the toolkit's.
 */
export const STYLE = `
.api-tab { container: api-tab / inline-size; display: grid; gap: 22px; }
.api-tab-compact { gap: 16px; }
.api-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.api-intro-text { display: grid; gap: 4px; max-width: 620px; }
.api-title { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
.api-intro-text p, .api-note { margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.55; }
.api-note code, .api-intro-text code { font-size: .92em; }
.api-tab-compact .api-title { font-size: 15px; }
.api-tab-compact .api-intro { flex-direction: column; align-items: stretch; gap: 10px; }

/* The person's keys */
.api-keys { list-style: none; display: grid; gap: 10px; margin: 0; padding: 0; }
.api-key { display: grid; overflow: hidden; }
.api-key-main { display: flex; align-items: center; gap: 12px; padding: 14px 14px 14px 16px; min-width: 0; }
.api-key-mark { display: grid; place-items: center; flex: none; width: 36px; height: 36px;
  border-radius: var(--radius-lg); background: var(--primary-soft); color: var(--primary-text); }
.api-key-text { display: grid; gap: 3px; flex: 1; min-width: 0; }
.api-key-name { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; font-weight: 620; }
.api-key-name > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.api-key-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; color: var(--muted-foreground);
  font-size: 12.5px; }
.api-key-meta code { font-size: 12px; }
.api-key-meta .copilotz-time { font-size: 12.5px; }
.api-key-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.api-key-ref { padding: 4px 16px 16px; border-top: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 35%, var(--card)); }
@container api-tab (max-width: 560px) {
  .api-intro { flex-direction: column; align-items: stretch; gap: 12px; }
  .api-key-main { flex-wrap: wrap; }
  .api-key-actions { width: 100%; justify-content: flex-end; margin-top: -4px; }
}

/* Trying it */
.api-try { display: grid; gap: 10px; }
.api-sub { margin: 0; font-size: 14.5px; font-weight: 650; }
.api-try-list { display: grid; gap: 10px; }
.api-try .copilotz-code-body, .api-made .copilotz-code-body { font-size: 12.5px; }

/* Making one */
.api-form { display: grid; gap: 18px; }
.api-choice { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 0; border: 0; }
.api-choice > legend { margin-bottom: 8px; padding: 0; font-size: 13.5px; font-weight: 600; }
.api-presets { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.api-preset { position: relative; display: grid; align-content: start; gap: 4px; padding: 12px 14px;
  border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--card); cursor: pointer;
  transition: border-color .15s, background-color .15s; }
.api-preset:hover { border-color: var(--ring); }
.api-preset[data-checked] { border-color: var(--primary-border); background: var(--primary-soft); }
.api-preset:has(input:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
.api-preset input { position: absolute; opacity: 0; pointer-events: none; }
.api-preset-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-weight: 620;
  font-size: 14px; }
.api-preset-check { display: grid; place-items: center; width: 18px; height: 18px; border-radius: var(--radius-full);
  border: 1.5px solid var(--input); color: transparent; }
.api-preset[data-checked] .api-preset-check { border-color: var(--primary); background: var(--primary);
  color: var(--primary-foreground); }
.api-preset-text { color: var(--muted-foreground); font-size: 12.5px; line-height: 1.45; }
.api-preset-names { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.api-name { padding: 1px 6px; border-radius: var(--radius-sm); background: var(--muted); color: var(--secondary-foreground);
  font: 11.5px/1.5 var(--font-mono); }
.api-preset[data-checked] .api-name { background: var(--card); }

/* A custom pick */
.api-custom { display: grid; gap: 14px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 30%, var(--card)); }
.api-custom-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.api-custom-head h4 { margin: 0; font-size: 13px; font-weight: 650; }
.api-custom-count { color: var(--muted-foreground); font-size: 12.5px; }
.api-pick { display: grid; gap: 8px; }
.api-pick-list { display: grid; gap: 2px; max-height: 240px; overflow: auto; margin: 0; padding: 4px;
  border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card); }
.api-pick-group { margin: 6px 6px 2px; color: var(--muted-foreground); font-size: 11.5px; font-weight: 650;
  letter-spacing: .04em; text-transform: uppercase; }
.api-pick-item { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px; border-radius: var(--radius-sm); }
.api-pick-item:hover { background: var(--accent); }
.api-pick-item .copilotz-checkbox { flex: 1; min-width: 0; }
.api-pick-label { display: grid; gap: 1px; min-width: 0; }
.api-pick-label code { font-size: 12.5px; }
.api-pick-label span { color: var(--muted-foreground); font-size: 12px; line-height: 1.4; }
.api-chips { display: flex; flex-wrap: wrap; gap: 6px; }

/* The secret, once */
.api-made { display: grid; gap: 14px; }
.api-secret .copilotz-code-body { font-size: 13.5px; }

/* A key's reference */
.api-ref { display: grid; gap: 10px; padding-top: 12px; }
.api-ref-item { display: grid; gap: 6px; padding: 12px 14px; border: 1px solid var(--border);
  border-radius: var(--radius-md); background: var(--card); }
.api-ref-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.api-ref-head code { font-size: 12.5px; overflow-wrap: anywhere; }
.api-ref-item p { margin: 0; color: var(--muted-foreground); font-size: 13px; line-height: 1.5; }
.api-ref-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 2px 0 0;
  font-size: 12.5px; }
.api-ref-fields dt code { font-size: 12px; }
.api-ref-fields dd { margin: 0; color: var(--muted-foreground); overflow-wrap: anywhere; }
.api-ref-optional { color: var(--muted-foreground); }
`;
