import {
  type AnyViewDefinition,
  type ViewActions,
  type ViewCollections,
  type ViewContext,
  type ViewHints,
  type ViewReference,
  type ViewShows,
  viewShowsKey,
  viewText,
} from "./definition.ts";

/** Only inert, JSON-shaped authorized projections may enter a View. Accessors,
 * prototypes, callable capabilities and cycles fail closed rather than executing. */
export function snapshotViewData(
  value: unknown,
  ancestors: Set<object> = new Set<object>(),
): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("View data must be inert and acyclic.");
  }
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) throw new TypeError("View data must use plain objects.");
  ancestors.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== "string" || !descriptor.enumerable ||
        !("value" in descriptor) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      ) throw new TypeError("Unsafe View data property.");
      (result as Record<string, unknown>)[key] = snapshotViewData(
        descriptor.value,
        ancestors,
      );
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
export interface OneShotViewRenderer {
  /** One session per nested render, with no subscriptions or tracking API. */
  open(context: Readonly<{ scope: unknown; signal: AbortSignal }>): {
    render(evaluate: () => Promise<unknown>): string | Promise<string>;
    dispose?(): void | Promise<void>;
  };
}
export interface TextRendererOptions {
  registry: {
    resolveView(
      shows: ViewShows,
      mode: string,
      renderer: string,
    ): AnyViewDefinition | undefined;
  };
  /** The host authorizes this reference and excludes hidden/protected fields.
   * There is deliberately no raw-value default, even for generic fallback. */
  project(
    reference: ViewReference,
    context: Readonly<{ scope: unknown; signal: AbortSignal }>,
  ): unknown | Promise<unknown>;
  /** Capabilities must already be bound to this viewer scope and authorize every
   * read. The renderer restricts their shape and snapshots results; it does not
   * turn an unscoped database client into an authorized reader. */
  collections?: ViewCollections;
  /** Allowed Action names only. Pure rendering exposes rejecting functions. */
  actions?: ViewActions;
  resources?: ViewContext["resources"];
  scope: unknown;
  renderers?: Readonly<Record<string, OneShotViewRenderer>>;
  maxDepth?: number;
}
const textRenderer: OneShotViewRenderer = {
  open: () => ({
    async render(evaluate) {
      const result = await evaluate();
      return typeof result === "string"
        ? result
        : JSON.stringify(snapshotViewData(result)) ?? "";
    },
  }),
};
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
  });
}
/** Bounded, pure one-shot rendering for context preparation. Interactive Action
 * invocation and live renderers are intentionally outside this foundation. */
export interface TextViewRenderer {
  render(
    reference: ViewReference,
    hints?: ViewHints,
    signal?: AbortSignal,
  ): Promise<string>;
}
export function createTextRenderer(
  options: TextRendererOptions,
): TextViewRenderer {
  if (typeof options.project !== "function") {
    throw new TypeError("An authorized View projection is required.");
  }
  const maxDepth = options.maxDepth ?? 32;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new TypeError("Invalid View nesting bound.");
  }
  const scope = snapshotViewData(options.scope);
  const resources = snapshotViewData(
    options.resources ?? {},
  ) as ViewContext["resources"];
  const renderers = { text: textRenderer, ...options.renderers };
  const actions = Object.fromEntries(
    Object.keys(options.actions ?? {}).map((name) => [name, () => {
      throw new TypeError(
        "Actions are unavailable during pure one-shot View rendering.",
      );
    }]),
  );
  return ({
    async render(
      reference: ViewReference,
      hints: ViewHints = {},
      externalSignal: AbortSignal = new AbortController().signal,
    ): Promise<string> {
      const render = async (
        ref: ViewReference,
        requested: ViewHints,
        depth: number,
        parentSignal: AbortSignal,
      ): Promise<string> => {
        parentSignal.throwIfAborted();
        if (depth > maxDepth) {
          throw new RangeError("View nesting limit exceeded.");
        }
        const lifetime = new AbortController();
        const signal = AbortSignal.any([parentSignal, lifetime.signal]);
        signal.throwIfAborted();
        // Never expose the instance used by the enforcement closures.
        const exposedSignal = AbortSignal.any([signal]);
        const children = new Set<Promise<string>>();
        let session: ReturnType<OneShotViewRenderer["open"]> | undefined;
        try {
          viewShowsKey(ref.shows);
          const hints = {
            mode: viewText(requested.mode ?? "context", "View mode"),
            renderer: viewText(requested.renderer ?? "text", "View renderer"),
          };
          const adapter = Object.hasOwn(renderers, hints.renderer)
            ? renderers[hints.renderer as keyof typeof renderers]
            : undefined;
          if (!adapter) {
            throw new TypeError(`No one-shot renderer '${hints.renderer}'.`);
          }
          const hostContext = { scope, signal: exposedSignal };
          const projected = snapshotViewData(
            await abortable(
              Promise.resolve().then(() => options.project(ref, hostContext)),
              signal,
            ),
          );
          signal.throwIfAborted();
          const view = options.registry.resolveView(
            ref.shows,
            hints.mode,
            hints.renderer,
          );
          const collections = (Object.fromEntries(
            Object.entries(options.collections ?? {}).map((
              [name, collection],
            ) => [
              name,
              {
                get: async (input: unknown) => {
                  signal.throwIfAborted();
                  return snapshotViewData(
                    await abortable(
                      Promise.resolve().then(() => collection.get(input)),
                      signal,
                    ),
                  );
                },
                list: async (input: unknown) => {
                  signal.throwIfAborted();
                  return snapshotViewData(
                    await abortable(
                      Promise.resolve().then(() => collection.list(input)),
                      signal,
                    ),
                  );
                },
              },
            ]),
          )) as ViewCollections;
          const context: ViewContext = {
            collections,
            actions: { ...actions },
            resources: snapshotViewData(resources) as ViewContext["resources"],
            scope: snapshotViewData(scope),
            signal: exposedSignal,
            hints: { ...hints },
            show: (nested: ViewReference, next: ViewHints = {}) => {
              const child = render(
                nested,
                { ...hints, ...next },
                depth + 1,
                signal,
              );
              children.add(child);
              // The owner observes detached failures and always drains their cleanup.
              child.then(
                () => children.delete(child),
                () => children.delete(child),
              );
              return child;
            },
          };
          session = adapter.open(hostContext);
          const currentSession = session;
          let evaluated = false;
          const result = await abortable(
            Promise.resolve().then(() =>
              currentSession.render(async () => {
                signal.throwIfAborted();
                if (evaluated) {
                  throw new TypeError(
                    "A one-shot renderer cannot evaluate twice.",
                  );
                }
                evaluated = true;
                return view
                  ? await view.render(projected as never, context)
                  : projected;
              })
            ),
            signal,
          );
          signal.throwIfAborted();
          if (typeof result !== "string") {
            throw new TypeError("One-shot renderer must return text.");
          }
          return result;
        } finally {
          lifetime.abort(new Error("View render lifetime ended."));
          await Promise.allSettled([...children]);
          await session?.dispose?.();
        }
      };
      return await render(reference, hints, 1, externalSignal);
    },
  });
}
