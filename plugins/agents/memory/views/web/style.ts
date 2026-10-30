/**
 * Memory's layout on the web, on the theme's variables: the memories page
 * (in the toolkit's `Page`), a space's Memories tab, and the same, compact,
 * in a side panel.
 */
export const STYLE = `
.mem-star { color: var(--warning); }
.mem-tools { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 12px 0; background: var(--background); }
.mem-search { flex: 1; min-width: 200px; }
.mem-group { margin-top: 22px; }
.mem-group h2 { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; font-size: 14.5px; font-weight: 650; }
.mem-group-icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--radius-full);
  background: var(--muted); color: var(--secondary-foreground); }
.mem-count { color: var(--muted-foreground); font-weight: 500; font-size: 12.5px; }
.mem-list { list-style: none; display: grid; gap: 8px; margin: 0; padding: 0; }
.mem-card { position: relative; padding: 13px 16px 11px; }
.mem-card .mem-text { padding-right: 28px; }
.mem-menu { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity .12s; }
.mem-card:is(:hover, :focus-within) .mem-menu, .mem-menu:has([aria-expanded=true]) { opacity: 1; }
@media (pointer: coarse) { .mem-menu { opacity: 1; } }
.mem-core { border-color: color-mix(in oklab, var(--warning) 35%, var(--border));
  background: linear-gradient(color-mix(in oklab, var(--warning) 6%, var(--card)), var(--card)); }
.mem-text { margin: 0; line-height: 1.55; overflow-wrap: anywhere; }
.mem-text .mem-star { margin-right: 6px; }
.mem-card footer { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-top: 8px;
  color: var(--muted-foreground); font-size: 12.5px; }
.mem-card .copilotz-time { font-size: 12.5px; }
.mem-source { margin-left: auto; font-size: 12.5px; }
.mem-none { margin: 28px 0; color: var(--muted-foreground); text-align: center; }
.mem-empty { margin-top: 56px; }
.mem-tab .mem-tools { padding-top: 0; }
.mem-tab .mem-empty { margin-top: 32px; }
.mem-intro { margin: 0 0 4px; color: var(--muted-foreground); font-size: 14px; }
.mem-body-compact .mem-tools { gap: 8px; padding: 0 0 8px; }
.mem-body-compact .mem-search { min-width: 0; }
.mem-body-compact .mem-group { margin-top: 16px; }
.mem-body-compact .mem-group h2 { font-size: 13.5px; }
.mem-body-compact .mem-card { padding: 10px 12px 9px; font-size: 14px; }
.mem-body-compact .mem-menu { top: 5px; right: 5px; }
`;
