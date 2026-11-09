/**
 * Boards' layout on the web, on the theme's variables: a board (its header,
 * filters, and columns side by side, scrolling sideways; stacked in a side
 * panel), its cards (labels, title, due date, a mark for a description, who
 * owns it), the slot a dragged card would land in and the copy that follows
 * the pointer, a card's details (a dialog; a sheet on a phone), a space's
 * boards (none yet, one, several), and an agent's call to a board's tool in
 * a conversation. Only layout: the pieces are the toolkit's.
 */
export const STYLE = `
.board, .board-ghost, .card-sheet, .boards, .board-step {
  --board-lane: color-mix(in oklab, var(--muted) 72%, var(--background));
  --board-hue-0: var(--chart-1);
  --board-hue-1: var(--chart-2);
  --board-hue-2: var(--chart-3);
  --board-hue-3: var(--chart-4);
  --board-hue-4: var(--chart-5);
  --board-hue-5: color-mix(in oklab, var(--chart-1) 55%, var(--chart-5));
  --board-hue-6: color-mix(in oklab, var(--chart-3) 50%, var(--chart-1));
  --board-hue-7: color-mix(in oklab, var(--chart-2) 50%, var(--chart-5));
}
@media (prefers-color-scheme: dark) {
  .board, .board-ghost, .card-sheet, .boards, .board-step {
    --board-lane: color-mix(in oklab, var(--muted) 55%, var(--background));
  }
}
.board-glyph { flex: none; display: inline-block; vertical-align: middle; }
.board-stage { flex: none; color: var(--muted-foreground); }
.board-stage[data-stage=todo] { color: color-mix(in oklab, var(--foreground) 50%, var(--background)); }
.board-stage[data-stage=doing] { color: var(--warning); }
.board-stage[data-stage=review] { color: var(--info); }
.board-stage[data-stage=blocked] { color: var(--destructive); }
.board-stage[data-stage=done] { color: var(--success); }
.board-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap; border: 0; }

/* A board: its head, its filters, then its columns */
.board { --board-col: 284px; container: board / inline-size; display: flex; flex-direction: column; gap: 14px;
  min-width: 0; min-height: 0; }
.board[data-mode=page] { flex: 1; }
.board-head { display: grid; gap: 4px; min-width: 0; }
.board-head-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-width: 0; }
.board-head-title { flex: 1 1 auto; display: flex; align-items: center; gap: 10px; min-width: 0; margin: 0;
  font-family: var(--font-display); font-size: 19px; font-weight: 660; letter-spacing: -.015em; }
.board-head-title > a { min-width: 0; overflow: hidden; color: inherit; text-decoration: none; text-overflow: ellipsis;
  white-space: nowrap; }
.board-head-title > a:hover { text-decoration: underline; text-underline-offset: 4px; text-decoration-thickness: 1px; }
.board-head-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: auto; }
.board-name { position: relative; display: inline; isolation: isolate; max-width: 100%; margin: 0; padding: 0; border: 0;
  background: transparent; color: inherit; font: inherit; letter-spacing: inherit; text-align: left; cursor: text; }
.board-name::before { content: ""; position: absolute; inset: -2px -7px; z-index: -1; border-radius: var(--radius-md);
  transition: background-color .12s; }
.board-name:hover::before { background: var(--accent); }
.board-name:focus-visible { outline: none; }
.board-name:focus-visible::before { outline: 2px solid var(--ring); }
.board-about { display: block; max-width: 72ch; margin: 2px -8px 0; padding: 4px 8px; border: 0; border-radius: var(--radius-md);
  background: transparent; color: var(--muted-foreground); font: inherit; font-size: 14px; line-height: 1.5;
  text-align: left; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; transition: background-color .12s; }
button.board-about:hover { background: var(--accent); color: var(--foreground); }
.board-about[data-empty] { color: color-mix(in oklab, var(--muted-foreground) 80%, transparent); font-style: normal; }
.board-about-edit { display: grid; gap: 8px; max-width: 72ch; }
.board-about-edit-end { display: flex; justify-content: flex-end; gap: 6px; }
.board-error { margin: 0; color: var(--destructive-text); font-size: 13px; }

.board-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.board-search { width: 230px; }
.board-filter[data-on] { border-color: var(--primary-border); background: var(--primary-soft); color: var(--primary-text); }
.board-filter-faces { display: inline-flex; margin-left: 2px; }
.board-filter-faces > * + * { margin-left: -6px; }
.board-filter-faces .copilotz-avatar { outline: 2px solid var(--card); }
.board-toolbar-end { display: flex; align-items: center; gap: 8px; margin-left: auto; color: var(--muted-foreground);
  font-size: 12.5px; font-variant-numeric: tabular-nums; }

/* The columns, side by side */
.board-scroller { display: flex; align-items: flex-start; gap: 12px; min-height: 0; margin: 0 -4px; padding: 2px 4px 14px;
  overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scroll-padding-inline: 4px;
  scrollbar-width: thin; }
.board[data-mode=page] .board-scroller { flex: 1; align-items: stretch; min-height: 300px; }
.board-column { flex: 0 0 var(--board-col); display: flex; flex-direction: column; width: var(--board-col); min-height: 0;
  max-height: 100%; border-radius: var(--radius-xl); background: var(--board-lane); scroll-snap-align: start;
  transition: background-color .15s, outline-color .15s; }
.board-column[data-over] { background: color-mix(in oklab, var(--ring) 7%, var(--board-lane));
  outline: 1px solid color-mix(in oklab, var(--ring) 30%, transparent); outline-offset: -1px; }
.board-column-head { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 8px 6px 6px 12px; }
.board-column-name { flex: 0 1 auto; min-width: 0; margin: 0; padding: 2px 4px; margin-left: -4px; overflow: hidden;
  border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--foreground); font: inherit;
  font-size: 13.5px; font-weight: 650; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
button.board-column-name { cursor: text; }
button.board-column-name:hover { background: color-mix(in oklab, var(--foreground) 6%, transparent); }
.board-column-name:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.board-column-rename { flex: 1; min-width: 0; }
.board-column-rename .copilotz-input { height: 30px; }
.board-column-count { color: var(--muted-foreground); font-size: 12.5px; font-weight: 550; font-variant-numeric: tabular-nums; }
.board-column-tools { display: flex; align-items: center; gap: 0; margin-left: auto; opacity: 0; transition: opacity .12s; }
.board-column:is(:hover, :focus-within) .board-column-tools, .board-column-tools:has([aria-expanded=true]) { opacity: 1; }
.board-list { position: relative; display: flex; flex-direction: column; gap: 8px; min-height: 8px; margin: 0;
  padding: 2px 8px 4px; overflow-x: hidden; overflow-y: auto; overscroll-behavior-y: contain; list-style: none;
  scrollbar-width: thin; }
.board-list:empty::after { content: ""; display: block; min-height: 40px; }
.board-column-foot { padding: 2px 8px 8px; }
.board-add { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 0 8px; border: 0;
  border-radius: var(--radius-md); background: transparent; color: var(--muted-foreground); font: inherit; font-size: 13px;
  font-weight: 560; text-align: left; cursor: pointer; transition: background-color .12s, color .12s; }
.board-add:hover { background: color-mix(in oklab, var(--foreground) 6%, transparent); color: var(--foreground); }
.board-add:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.board-quick { display: grid; gap: 8px; padding: 8px; border: 1px solid var(--ring); border-radius: var(--radius-lg);
  background: var(--card); box-shadow: var(--shadow-sm); }
.board-quick .copilotz-textarea { font-size: 14px; font-weight: 520; }
.board-quick-end { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
.board-quick-hint { color: var(--muted-foreground); font-size: 12px; }
.board-quick-hint .copilotz-kbd { margin: 0 1px; }
.board-quick-buttons { display: flex; gap: 4px; }
.board-grow { margin-right: auto; }
.board-column-error { padding: 0 12px 6px; }
.card-sheet-say { margin: 0; }
.board-new-column { flex: 0 0 var(--board-col); display: grid; align-content: start; gap: 8px; width: var(--board-col); }
.board-new-column > button { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px;
  border: 1.5px dashed var(--input); border-radius: var(--radius-xl); background: transparent; color: var(--muted-foreground);
  font: inherit; font-size: 13.5px; font-weight: 560; cursor: pointer; transition: border-color .15s, color .15s, background-color .15s; }
.board-new-column > button:hover { border-color: var(--ring); background: var(--board-lane); color: var(--foreground); }
.board-new-column > button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.board-new-column form { display: grid; gap: 8px; padding: 10px; border-radius: var(--radius-xl); background: var(--board-lane); }
.board-new-column-end { display: flex; justify-content: flex-end; gap: 6px; }

/* A card */
.board-card { position: relative; flex: none; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); color: var(--card-foreground); box-shadow: var(--shadow-sm); cursor: grab;
  touch-action: manipulation; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  transition: border-color .15s, box-shadow .15s, opacity .15s; }
.board-card:hover { border-color: var(--input); box-shadow: var(--shadow-md); }
.board-card[data-lifted] { display: none; }
.board-card[data-held] { z-index: 1; border-color: var(--ring); box-shadow: var(--shadow-lg);
  outline: 2px solid color-mix(in oklab, var(--ring) 40%, transparent); outline-offset: 2px; rotate: .8deg; }
.board-card[data-busy] { opacity: .7; }
.board-card-open { display: grid; gap: 7px; width: 100%; padding: 10px 12px; border: 0; border-radius: inherit;
  background: transparent; color: inherit; font: inherit; text-align: left; cursor: inherit; }
.board-card-open:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.board-card-open > :first-child { padding-right: 22px; }
.board-card-labels { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.board-label { --hue: var(--board-hue-0); display: inline-flex; align-items: center; gap: 5px; max-width: 100%; height: 20px;
  padding: 0 8px 0 7px; border-radius: var(--radius-full); background: color-mix(in oklab, var(--hue) 13%, var(--card));
  color: color-mix(in oklab, var(--hue) 70%, var(--foreground)); font-size: 11.5px; font-weight: 620; line-height: 1;
  white-space: nowrap; }
.board-label::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: var(--radius-full); background: var(--hue); }
.board-label > span { min-width: 0; overflow: hidden; line-height: 1.4; text-overflow: ellipsis; }
.board-label[data-hue="1"] { --hue: var(--board-hue-1); }
.board-label[data-hue="2"] { --hue: var(--board-hue-2); }
.board-label[data-hue="3"] { --hue: var(--board-hue-3); }
.board-label[data-hue="4"] { --hue: var(--board-hue-4); }
.board-label[data-hue="5"] { --hue: var(--board-hue-5); }
.board-label[data-hue="6"] { --hue: var(--board-hue-6); }
.board-label[data-hue="7"] { --hue: var(--board-hue-7); }
.board-card-title { display: -webkit-box; overflow: hidden; font-size: 14px; font-weight: 560; line-height: 1.42;
  overflow-wrap: anywhere; -webkit-box-orient: vertical; -webkit-line-clamp: 4; }
.board-card-meta { display: flex; align-items: center; gap: 8px; min-height: 22px; color: var(--muted-foreground);
  font-size: 12px; }
.board-card-mark { display: inline-flex; align-items: center; color: var(--muted-foreground); }
.board-card-who { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; min-width: 0; }
.board-due { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 7px 0 6px;
  border-radius: var(--radius-sm); background: var(--muted); color: var(--muted-foreground); font-size: 11.5px;
  font-weight: 620; white-space: nowrap; font-variant-numeric: tabular-nums; }
.board-due[data-tone=overdue] { background: var(--destructive-soft); color: var(--destructive-text); }
.board-due[data-tone=today] { background: var(--warning-soft); color: var(--warning-text); }
.board-due[data-tone=soon] { color: var(--foreground); }
.board-due[data-tone=done] { background: transparent; padding-left: 0; text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--muted-foreground) 60%, transparent); }
.board-card-menu { position: absolute; top: 5px; right: 5px; opacity: 0; transition: opacity .12s; }
.board-card:is(:hover, :focus-within) .board-card-menu, .board-card-menu:has([aria-expanded=true]) { opacity: 1; }
@media (pointer: coarse) {
  .board-card-menu { opacity: .75; }
  .board-column-tools { opacity: 1; }
}

/* Where a dragged card would land, and the copy that follows the pointer */
.board-slot { flex: none; border: 1.5px dashed color-mix(in oklab, var(--ring) 60%, transparent); border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--ring) 9%, transparent); animation: board-slot .16s cubic-bezier(.2, .8, .2, 1); }
@keyframes board-slot { from { height: 0; opacity: 0; } }
.board-ghost { position: fixed; top: 0; left: 0; z-index: 2147483000; margin: 0; list-style: none; pointer-events: none;
  cursor: grabbing; border-color: var(--input); box-shadow: var(--shadow-lg); rotate: 2.2deg; scale: 1.035;
  animation: board-lift .16s cubic-bezier(.2, .8, .2, 1); will-change: translate; }
@keyframes board-lift { from { rotate: 0deg; scale: 1; box-shadow: var(--shadow-sm); } }
.board-ghost .board-card-menu { display: none; }
.board-ghost-settling { rotate: 0deg; scale: 1; box-shadow: var(--shadow-md);
  transition: translate .17s cubic-bezier(.2, .8, .2, 1), rotate .17s, scale .17s, width .17s, box-shadow .17s; }
:root[data-board-dragging], :root[data-board-dragging] * { cursor: grabbing !important; user-select: none; -webkit-user-select: none; }
@media (prefers-reduced-motion: reduce) {
  .board-slot, .board-ghost { animation: none; }
  .board-ghost { rotate: 0deg; scale: 1; }
}

/* In a side panel: the columns stacked, each folding */
.board[data-mode=panel] { --board-col: auto; gap: 10px; }
.board[data-mode=panel] .board-scroller { flex-direction: column; align-items: stretch; gap: 8px; margin: 0; padding: 0;
  overflow: visible; scroll-snap-type: none; }
.board[data-mode=panel] .board-column { flex: none; width: auto; max-height: none; }
.board[data-mode=panel] .board-list { overflow: visible; }
.board[data-mode=panel] .board-list[data-folded] { display: none; }
.board[data-mode=panel] .board-column-head { min-height: 38px; padding: 4px 4px 4px 6px; }
.board[data-mode=panel] .board-search { flex: 1 1 140px; width: auto; }
.board[data-mode=panel] .board-new-column { width: auto; flex: none; }
.board-fold { display: grid; place-items: center; width: 24px; height: 24px; margin-right: -2px; padding: 0; border: 0;
  border-radius: var(--radius-sm); background: transparent; color: var(--muted-foreground); cursor: pointer;
  transition: rotate .15s, background-color .12s; }
.board-fold:hover { background: color-mix(in oklab, var(--foreground) 6%, transparent); color: var(--foreground); }
.board-fold[aria-expanded=false] { rotate: -90deg; }
.board-fold:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }

@container board (max-width: 640px) {
  .board { --board-col: min(82cqi, 310px); }
  .board:not([data-mode=panel]) .board-scroller { scroll-snap-type: x proximity; }
  .board-search { flex: 1 1 100%; width: auto; }
  .board-count { display: none; }
}

/* Choosing among people, labels, columns: a popover's list */
.board-options { display: grid; gap: 1px; max-height: 320px; overflow: auto; }
.board-options-head { margin: 6px 8px 2px; color: var(--muted-foreground); font-size: 11px; font-weight: 680;
  letter-spacing: .05em; text-transform: uppercase; }
.board-options-search { padding: 2px 2px 6px; }
.board-option { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 4px 8px; border: 0;
  border-radius: var(--radius-md); background: transparent; color: inherit; font: inherit; font-size: 13.5px;
  text-align: left; cursor: pointer; }
.board-option:is(:hover, :focus-visible) { background: var(--accent); outline: none; }
.board-option-text { flex: 1; display: grid; min-width: 0; }
.board-option-text > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.board-option-note { color: var(--muted-foreground); font-size: 12px; }
.board-option-count { color: var(--muted-foreground); font-size: 12px; font-variant-numeric: tabular-nums; }
.board-option-check { flex: none; color: var(--primary-text); visibility: hidden; }
.board-option[aria-checked=true] .board-option-check, .board-option[aria-selected=true] .board-option-check { visibility: visible; }
.board-option-none { margin: 10px 8px; color: var(--muted-foreground); font-size: 13px; }
.board-unassigned { display: grid; place-items: center; flex: none; width: 24px; height: 24px; border: 1.5px dashed var(--input);
  border-radius: var(--radius-full); color: var(--muted-foreground); }

/* A card's details: a dialog, a sheet on a phone */
.card-sheet { display: flex; flex-direction: column; flex: 1; min-height: 0; max-height: min(88dvh, 880px); }
.copilotz-drawer .card-sheet { max-height: 88dvh; }
.card-sheet-head { display: flex; align-items: center; gap: 6px; padding: 14px 12px 2px 18px; }
.card-sheet-where { display: inline-flex; align-items: center; gap: 6px; min-width: 0; color: var(--muted-foreground);
  font-size: 13px; }
.card-sheet-where a { overflow: hidden; color: inherit; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.card-sheet-where a:hover { color: var(--foreground); text-decoration: underline; text-underline-offset: 3px; }
.card-sheet-head-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }
.card-sheet-body { display: grid; align-content: start; gap: 18px; flex: 1; min-height: 0; padding: 6px 22px 20px;
  overflow: auto; overscroll-behavior: contain; }
.card-sheet-title.copilotz-textarea { font-family: var(--font-display); font-size: 22px; font-weight: 650; line-height: 1.3;
  letter-spacing: -.015em; }
.card-props { display: grid; grid-template-columns: 104px minmax(0, 1fr); align-items: center; gap: 4px 12px; margin: 0; }
.card-props dt { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 13px; font-weight: 560; }
.card-props dt .board-glyph, .card-props dt .copilotz-icon { opacity: .85; }
.card-props dd { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; min-height: 36px;
  margin: 0 0 0 -8px; }
.card-prop { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 32px;
  padding: 0 10px 0 8px; border: 0; border-radius: var(--radius-md); background: transparent; color: inherit; font: inherit;
  font-size: 13.5px; font-weight: 540; text-align: left; cursor: pointer; transition: background-color .12s; }
.card-prop:hover { background: var(--accent); }
.card-prop:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.card-prop[data-empty] { color: var(--muted-foreground); font-weight: 500; }
.card-prop > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-prop-labels { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.card-prop-labels .board-label { height: 24px; padding-right: 3px; }
.card-label-x { display: grid; place-items: center; width: 18px; height: 18px; margin-left: 2px; padding: 0; border: 0;
  border-radius: var(--radius-full); background: transparent; color: inherit; cursor: pointer; opacity: .7; }
.card-label-x:hover { background: color-mix(in oklab, var(--hue) 22%, transparent); opacity: 1; }
.card-label-x:focus-visible { outline: 2px solid var(--ring); }
.card-due { display: flex; align-items: center; gap: 6px; padding-left: 8px; }
.card-due .copilotz-input { height: 34px; width: 170px; }
.card-due-said { color: var(--muted-foreground); font-size: 12.5px; }
.card-due-said[data-tone=overdue] { color: var(--destructive-text); font-weight: 600; }
.card-due-said[data-tone=today] { color: var(--warning-text); font-weight: 600; }
.card-desc { display: grid; gap: 8px; }
.card-desc-head { display: flex; align-items: center; gap: 10px; min-height: 30px; }
.card-desc-head h3 { flex: 1; margin: 0; font-size: 13px; font-weight: 650; color: var(--muted-foreground);
  letter-spacing: .02em; }
.card-desc-view { display: block; width: calc(100% + 24px); min-height: 64px; margin: 0 -12px; padding: 10px 12px; border: 0;
  border-radius: var(--radius-lg); background: transparent; color: inherit; font: inherit; text-align: left; cursor: text;
  transition: background-color .12s; }
.card-desc-view:hover { background: color-mix(in oklab, var(--muted) 70%, transparent); }
.card-desc-view:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
.card-desc-view[data-empty] { color: var(--muted-foreground); font-size: 14px; }
.card-desc-view .copilotz-md { font-size: 14.5px; }
.card-desc .copilotz-textarea { min-height: 160px; font-size: 14.5px; line-height: 1.6; }
.card-desc-preview { min-height: 160px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); }
.card-desc-end { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.card-desc-end .board-quick-hint { flex: 1; }
.card-sheet-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 12px 16px 12px 22px;
  border-top: 1px solid var(--border); background: color-mix(in oklab, var(--muted) 45%, var(--popover));
  color: var(--muted-foreground); font-size: 12.5px; }
.card-sheet-foot .copilotz-time { font-size: 12.5px; }
.card-sheet-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; flex: 1; min-width: 0; }
.card-sheet-meta > span + span::before { content: "·"; margin-right: 8px; }
.card-sheet-end { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.card-sheet-error { margin: 0; color: var(--destructive-text); font-size: 13px; }
@media (max-width: 640px) {
  .card-sheet-body { padding: 4px 16px 18px; }
  .card-props { grid-template-columns: 92px minmax(0, 1fr); }
  .card-sheet-title.copilotz-textarea { font-size: 20px; }
  .card-sheet-foot { padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); }
}

/* A board's page */
.board-page.copilotz-page-full > .copilotz-page-inner { display: flex; flex-direction: column; height: 100%; padding-bottom: 8px; }
.board-page .copilotz-page-body { display: flex; flex: 1; flex-direction: column; min-height: 0; margin-top: 14px; }
.board-page .copilotz-page-description { max-width: none; margin-top: 2px; }
.board-missing, .board-loading { display: grid; gap: 14px; }
.board-missing { min-height: 60vh; place-items: center; padding: 24px; }
.board-loading-columns { display: flex; gap: 12px; overflow: hidden; }
.board-loading-columns > * { flex: 0 0 284px; }

/* A space's boards */
.boards { container: boards / inline-size; display: grid; gap: 18px; }
.boards-empty { display: grid; justify-items: center; gap: 20px; padding: 28px 0 8px; }
.boards-empty .copilotz-empty-text { max-width: 50ch; }
.boards-preview { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; width: min(100%, 720px);
  padding: 12px; border-radius: var(--radius-2xl); background: var(--board-lane); }
.boards-preview-column { display: grid; align-content: start; gap: 6px; min-width: 0; }
.boards-preview-column b { display: flex; align-items: center; gap: 6px; min-width: 0; margin: 2px 2px 4px; overflow: hidden;
  font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.boards-preview-card { height: 30px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--card);
  box-shadow: var(--shadow-sm); }
.boards-preview-card:nth-child(3) { height: 22px; opacity: .7; }
.boards-teach { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; width: min(100%, 720px); margin: 0;
  padding: 0; list-style: none; }
.boards-teach li { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--card); font-size: 13px; line-height: 1.45; }
.boards-teach b { font-size: 13px; }
.boards-teach span { color: var(--muted-foreground); }
.boards-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; }
.boards-head > .copilotz-select { flex: 1; }
.boards-intro { flex: 1 1 320px; margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.5; }
.boards-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin: 0; padding: 0;
  list-style: none; }
.boards-item { display: grid; gap: 10px; height: 100%; padding: 14px 16px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); box-shadow: var(--shadow-sm); color: inherit; text-decoration: none;
  transition: border-color .15s, box-shadow .15s; }
.boards-item:hover { border-color: var(--input); box-shadow: var(--shadow-md); }
.boards-item:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.boards-item-name { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: 15px; font-weight: 650; }
.boards-item-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.boards-item-about { display: -webkit-box; overflow: hidden; margin: 0; color: var(--muted-foreground); font-size: 13px;
  line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.boards-bar { display: flex; height: 6px; overflow: hidden; border-radius: var(--radius-full); background: var(--muted); gap: 2px; }
.boards-bar > span { min-width: 4px; background: currentColor; }
.boards-bar > [data-stage=backlog] { color: color-mix(in oklab, var(--muted-foreground) 45%, var(--muted)); }
.boards-bar > [data-stage=todo] { color: color-mix(in oklab, var(--foreground) 35%, var(--muted)); }
.boards-bar > [data-stage=doing] { color: var(--warning); }
.boards-bar > [data-stage=review] { color: var(--info); }
.boards-bar > [data-stage=blocked] { color: var(--destructive); }
.boards-bar > [data-stage=done] { color: var(--success); }
.boards-item-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--muted-foreground);
  font-size: 12.5px; }
.boards-item-meta .copilotz-time { font-size: 12.5px; }
.boards-archived summary { cursor: pointer; color: var(--muted-foreground); font-size: 13px; font-weight: 600; }
.boards-archived[open] summary { margin-bottom: 10px; }
.boards-new { display: grid; gap: 14px; }
.boards-new-end { display: flex; justify-content: flex-end; gap: 8px; }
@container boards (max-width: 560px) {
  .boards-preview { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .boards-preview-column:nth-child(n + 4) { display: none; }
  .boards-teach { grid-template-columns: 1fr; }
}

/* A call to a board's tool, in a conversation */
.board-step { display: inline-flex; align-items: flex-start; gap: 8px; max-width: 100%; color: var(--muted-foreground);
  font-size: 13px; line-height: 24px; }
.board-step-mark { display: grid; place-items: center; flex: none; width: 22px; height: 22px; margin-top: 1px;
  border-radius: var(--radius-sm); background: var(--primary-soft); color: var(--primary-text); }
.board-step-mark[data-failed] { background: var(--warning-soft); color: var(--warning-text); }
.board-step-head { min-width: 0; color: var(--foreground); overflow-wrap: anywhere; }
.board-step-head b { font-weight: 640; }
.board-step-head[data-failed] { color: var(--muted-foreground); }
.board-step-link { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-height: 22px; margin-left: 2px;
  padding: 0 9px 0 7px; border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--card);
  color: var(--foreground); font-size: 12.5px; font-weight: 600; line-height: 1.2; text-decoration: none;
  vertical-align: middle; box-shadow: var(--shadow-sm); transition: border-color .12s, background-color .12s; }
.board-step-link + .board-step-link { margin-left: 4px; }
.board-step-note { margin-left: 6px; color: var(--muted-foreground); }
.board-step-link:hover { border-color: var(--input); background: var(--muted); }
.board-step-link > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
