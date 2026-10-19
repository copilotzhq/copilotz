/** Portable View authoring. Views receive projected data, never persistence handles. */
export type ViewShows =
  | string
  | Readonly<{ list: string }>
  | Readonly<{ action: string }>
  | Readonly<{ navigation: string }>;
export type ViewHints = Readonly<{ mode?: string; renderer?: string }>;
export type ViewReference<T = unknown> = Readonly<
  { shows: ViewShows; value: T }
>;
export type ViewRead<T = unknown> = Readonly<{
  value: T;
  status: "ready" | "missing";
  pending: boolean;
}>;
export type ViewCollections = Readonly<
  Record<
    string,
    Readonly<{
      get(input: unknown): Promise<ViewRead>;
      list(input: unknown): Promise<ViewRead>;
      query?(
        name: string,
        input: Readonly<Record<string, unknown>>,
      ): Promise<ViewRead>;
    }>
  >
>;
export type ViewActions = Readonly<Record<string, (input: unknown) => unknown>>;
export interface ViewContext<Shown = string> {
  readonly collections: ViewCollections;
  readonly actions: ViewActions;
  readonly resources: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly scope: unknown;
  readonly signal: AbortSignal;
  readonly hints: Readonly<{ mode: string; renderer: string }>;
  show(reference: ViewReference, hints?: ViewHints): Promise<Shown>;
}
export interface ViewDefinition<
  T = unknown,
  R = unknown,
  Context extends ViewContext<unknown> = ViewContext,
> {
  readonly id: string;
  readonly shows: ViewShows;
  readonly renderer: string;
  readonly modes: readonly string[];
  render(item: T, context: Context): R | Promise<R>;
}
// Method bivariance retains concrete item/result inference in heterogeneous maps.
export type AnyViewDefinition = ViewDefinition<
  never,
  unknown,
  ViewContext<unknown>
>;
export type ViewMap = Readonly<Record<string, AnyViewDefinition>>;
const keys = new Set(["id", "shows", "renderer", "modes", "render"]);
export function viewText(value: unknown, label: string): string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    [...value].some((character) =>
      character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127
    )
  ) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}
export function viewShowsKey(shows: ViewShows): string {
  if (typeof shows === "string") {
    return JSON.stringify(["datum", viewText(shows, "View shows")]);
  }
  if (
    !shows || typeof shows !== "object" || Array.isArray(shows) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(shows))
  ) {
    throw new TypeError(
      "View shows must be a kind or a list/action/navigation reference.",
    );
  }
  const entries = Object.entries(shows);
  if (
    entries.length !== 1 ||
    !["list", "action", "navigation"].includes(entries[0][0])
  ) {
    throw new TypeError(
      "View shows must have exactly one list/action/navigation key.",
    );
  }
  return JSON.stringify([
    entries[0][0],
    viewText(entries[0][1], "View shows target"),
  ]);
}
export function isViewDefinition(value: unknown): value is AnyViewDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return false;
  }
  const candidate = value as ViewDefinition;
  try {
    if (Object.keys(value).some((key) => !keys.has(key))) return false;
    viewText(candidate.id, "View id");
    viewText(candidate.renderer, "View renderer");
    viewShowsKey(candidate.shows);
    if (
      !Array.isArray(candidate.modes) || !candidate.modes.length ||
      new Set(candidate.modes).size !== candidate.modes.length
    ) return false;
    candidate.modes.forEach((mode) => viewText(mode, "View mode"));
    return typeof candidate.render === "function";
  } catch {
    return false;
  }
}
export function defineView<
  T = unknown,
  R = unknown,
  Context extends ViewContext<unknown> = ViewContext,
>(
  definition: ViewDefinition<T, R, Context>,
): ViewDefinition<T, R, Context> {
  if (!isViewDefinition(definition)) {
    throw new TypeError("Invalid View definition.");
  }
  return ({
    ...definition,
    shows: typeof definition.shows === "string"
      ? definition.shows
      : ({ ...definition.shows }),
    modes: [...definition.modes],
  });
}
