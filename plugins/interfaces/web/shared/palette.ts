/**
 * The command palette in the shell: the front ends that fill it (the
 * `palette` resource), in their order; the page open, as its Views hear it
 * (`hints.page`); and the key that opens it, ⌘K on Apple's computers and
 * Ctrl+K elsewhere (on a Mac, Ctrl+K is the field's own: it cuts to the end
 * of the line).
 */

/**
 * A `palette` resource: a View that lists, for what's typed and where the
 * person is, groups of items (`PaletteGroup[]`, see `hosts/web`), with item
 * `{}` and hints `{ search, in, path, page, query }`. Lower `order`, sooner,
 * where groups tie.
 */
export type PaletteSource = { view: string; order?: number };

/** The front ends that fill it, in their order, leaving out those taken away (`null`). */
export function sourcesOf(given: unknown): PaletteSource[] {
  return Object.entries((given ?? {}) as Record<string, PaletteSource | null>)
    .flatMap(([key, source]) => source?.view ? [{ ...source, key }] : [])
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.key.localeCompare(b.key))
    .map(({ view, order }) => ({ view, ...(order === undefined ? {} : { order }) }));
}

/** The page an address opens: its kind (`thread`, `space`, `home`) and its document's id. */
export function pageOf(path: string): { kind: string; id?: string } {
  const [kind, ...rest] = path.split("/").filter(Boolean).map(decodeURIComponent);
  const id = rest.join("/");
  return kind ? { kind, ...(id ? { id } : {}) } : { kind: "home" };
}

/** Whether this computer is Apple's, whose shortcuts take ⌘. */
export const apple = (platform = globalThis.navigator?.platform ?? "") =>
  /Mac|iP(hone|ad|od)/.test(platform);

/** Whether a key press opens (or closes) the palette. */
export function opens(
  event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean,
): boolean {
  if (event.key.toLowerCase() !== "k" || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The key, as a keycap says it. */
export const shortcutOf = (mac: boolean) => mac ? "⌘K" : "Ctrl K";
