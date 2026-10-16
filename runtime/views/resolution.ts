import {
  type AnyViewDefinition,
  isViewDefinition,
  type ViewMap,
  type ViewShows,
  viewShowsKey,
  viewText,
} from "./definition.ts";
export type ViewPreference = Readonly<
  { shows: ViewShows; mode: string; renderer: string; view: string }
>;
const key = (shows: ViewShows, mode: string, renderer: string) =>
  JSON.stringify([
    viewShowsKey(shows),
    viewText(mode, "View mode"),
    viewText(renderer, "View renderer"),
  ]);
/** Preferences choose a candidate; they can never replace an executable ID. */
export function createViewResolver(
  views: ViewMap,
  preference?: unknown,
): (
  shows: ViewShows,
  mode: string,
  renderer: string,
) => AnyViewDefinition | undefined {
  const candidates = new Map<string, AnyViewDefinition[]>();
  const ids = new Set<string>();
  for (const view of Object.values(views)) {
    if (!isViewDefinition(view)) {
      throw new TypeError("Invalid View definition.");
    }
    if (ids.has(view.id)) {
      throw new TypeError(`Duplicate View id '${view.id}'.`);
    }
    ids.add(view.id);
    for (const mode of view.modes) {
      const k = key(view.shows, mode, view.renderer);
      candidates.set(k, [...(candidates.get(k) ?? []), view]);
    }
  }
  if (preference !== undefined && !Array.isArray(preference)) {
    throw new TypeError("views.prefer must be a preference array.");
  }
  const chosen = new Map<string, AnyViewDefinition>();
  for (const raw of (preference ?? []) as unknown[]) {
    if (
      !raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "mode,renderer,shows,view"
    ) throw new TypeError("Invalid views.prefer entry.");
    const entry = raw as ViewPreference;
    const k = key(entry.shows, entry.mode, entry.renderer);
    const winner = candidates.get(k)?.find((view) => view.id === entry.view);
    if (!winner) {
      throw new TypeError(
        `views.prefer '${entry.view}' is not a matching candidate.`,
      );
    }
    if (chosen.has(k)) throw new TypeError("Duplicate views.prefer selection.");
    chosen.set(k, winner);
  }
  for (const [k, values] of candidates) {
    if (values.length > 1 && !chosen.has(k)) {
      throw new TypeError(
        `Ambiguous Views: ${
          values.map((view) => view.id).join(", ")
        }. Declare views.prefer.`,
      );
    }
    if (!chosen.has(k)) chosen.set(k, values[0]);
  }
  return (shows, mode, renderer) => chosen.get(key(shows, mode, renderer));
}
