/**
 * Cloud computers' layout on the web, on the theme's variables: the state
 * badge, the sizes to choose from, a computer made, and one asleep or
 * waking. Only layout: the pieces are the toolkit's.
 */
export const STYLE = `
/* Its state, beside its name */
.cloud-state { gap: 5px; }
.cloud-state-dot { width: 6px; height: 6px; border-radius: var(--radius-full); background: currentColor; opacity: .8; }
.cloud-state[data-state=asleep] .cloud-state-dot, .cloud-state[data-state=cold] .cloud-state-dot {
  box-sizing: border-box; background: transparent; border: 1.5px solid currentColor; }
.cloud-state-spin { --size: 9px; }
.cloud-awake { color: var(--success-text); }

/* Making one */
.cloud-new { display: grid; gap: 18px; }
.cloud-sizes { min-width: 0; margin: 0; padding: 0; border: 0; }
.cloud-legend { margin-bottom: 8px; padding: 0; font-size: 13.5px; font-weight: 600; }
.cloud-sizes-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.cloud-size { position: relative; display: grid; gap: 4px; padding: 14px 16px 15px; border: 1px solid var(--border);
  border-radius: var(--radius-xl); background: var(--card); box-shadow: var(--shadow-sm); cursor: pointer;
  transition: border-color .15s, background-color .15s, box-shadow .15s; }
.cloud-size:hover { border-color: var(--input); }
.cloud-size[data-checked] { border-color: var(--primary); background: color-mix(in oklab, var(--primary) 5%, var(--card));
  outline: 1px solid var(--primary); outline-offset: -2px; }
.cloud-size:has(:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
.cloud-sizes:disabled .cloud-size { cursor: default; opacity: .6; }
.cloud-size-input { position: absolute; opacity: 0; pointer-events: none; }
.cloud-size-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cloud-size-label { font-family: var(--font-display); font-size: 16px; font-weight: 650; letter-spacing: -.01em; }
.cloud-size-check { display: grid; place-items: center; width: 20px; height: 20px; border: 1.5px solid var(--input);
  border-radius: var(--radius-full); color: transparent; transition: background-color .15s, border-color .15s; }
.cloud-size[data-checked] .cloud-size-check { border-color: var(--primary); background: var(--primary);
  color: var(--primary-foreground); }
.cloud-size-specs { font-size: 14px; font-variant-numeric: tabular-nums; }
.cloud-size-cpu { color: var(--muted-foreground); font-size: 12.5px; }
.cloud-size-price { margin-top: 8px; padding-top: 9px; border-top: 1px solid var(--border); color: var(--muted-foreground);
  font-size: 13px; font-variant-numeric: tabular-nums; }
.cloud-size-price b { color: var(--foreground); font-size: 15px; font-weight: 650; }
.cloud-new-how { display: flex; align-items: flex-start; gap: 8px; margin: -6px 0 0; color: var(--muted-foreground);
  font-size: 13px; line-height: 1.5; }
.cloud-new-how .copilotz-icon { flex: none; margin-top: 2px; }
.cloud-new-name { max-width: 420px; }
.cloud-new-go { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px;
  padding-top: 14px; border-top: 1px solid var(--border); }
.cloud-new-summary { color: var(--muted-foreground); font-size: 13px; font-variant-numeric: tabular-nums; }
@media (max-width: 560px) {
  .cloud-new-go .copilotz-button { width: 100%; }
}

/* Made */
.cloud-made { display: flex; align-items: flex-start; gap: 14px; padding: 4px 0; }
.cloud-made-icon { display: grid; place-items: center; flex: none; width: 46px; height: 46px; border-radius: var(--radius-full);
  background: var(--success-soft); color: var(--success-text); }
.cloud-made-text { display: grid; gap: 6px; justify-items: start; }
.cloud-made-text p { margin: 0; color: var(--muted-foreground); line-height: 1.55; }
.cloud-made-text .cloud-made-name { color: var(--foreground); font-size: 16px; font-weight: 650; }
.cloud-made-text .copilotz-button { margin-top: 8px; }

/* Asleep, or waking */
.cloud-asleep { display: grid; justify-items: center; gap: 12px; max-width: 520px; margin: 12px auto; padding: 28px 24px 22px;
  border: 1px solid var(--border); border-radius: var(--radius-2xl); background: var(--card); box-shadow: var(--shadow-sm);
  text-align: center; }
.cloud-asleep-mark { position: relative; display: grid; place-items: center; width: 56px; height: 56px;
  border-radius: var(--radius-2xl); background: var(--muted); color: var(--muted-foreground); }
.cloud-asleep[data-phase=waking] .cloud-asleep-mark, .cloud-asleep[data-phase=connecting] .cloud-asleep-mark {
  background: var(--info-soft); color: var(--info-text); }
.cloud-asleep-ring { position: absolute; inset: -5px; border-radius: calc(var(--radius-2xl) + 5px);
  border: 2px solid var(--info); opacity: 0; }
.cloud-asleep[data-phase=waking] .cloud-asleep-ring, .cloud-asleep[data-phase=connecting] .cloud-asleep-ring {
  animation: cloud-ring 1.8s ease-out infinite; }
@keyframes cloud-ring { 0% { opacity: .55; transform: scale(.92); } 100% { opacity: 0; transform: scale(1.18); } }
@media (prefers-reduced-motion: reduce) { .cloud-asleep-ring { animation: none !important; } }
.cloud-asleep-text h3 { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 650; letter-spacing: -.015em; }
.cloud-asleep-text p { margin: 6px 0 0; color: var(--muted-foreground); line-height: 1.55; }
.cloud-wake { display: flex; align-items: center; gap: 10px; width: min(340px, 100%); }
.cloud-progress { flex: 1; height: 6px; border-radius: var(--radius-full); background: var(--muted); overflow: hidden; }
.cloud-progress-bar { display: block; height: 100%; border-radius: var(--radius-full); background: var(--info);
  transition: width .25s linear; }
.cloud-wake-time { min-width: 32px; color: var(--muted-foreground); font-size: 12.5px; font-variant-numeric: tabular-nums;
  text-align: right; }
.cloud-asleep-error { width: 100%; text-align: left; }
.cloud-asleep-note { margin: 4px 0 0; color: var(--muted-foreground); font-size: 12.5px; line-height: 1.5; }
`;
