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

type SnapshotLimits = Readonly<{
  maxDepth?: number;
  maxNodes?: number;
  maxBytes?: number;
}>;
type DataBudget = { depth: number; nodes: number; bytes: number };
function positiveBound(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Invalid View ${label} bound.`);
  }
  return value;
}
function dataBudget(options: SnapshotLimits): DataBudget {
  return {
    depth: positiveBound(options.maxDepth ?? 32, "depth"),
    nodes: positiveBound(options.maxNodes ?? 20_000, "node"),
    bytes: positiveBound(options.maxBytes ?? 65_536, "byte"),
  };
}
function chargeBytes(budget: DataBudget, text: string): void {
  // The character check prevents allocating an unbounded UTF-8 temporary.
  if (text.length > budget.bytes) {
    throw new RangeError("View byte limit exceeded.");
  }
  budget.bytes -= new TextEncoder().encode(text).byteLength;
  if (budget.bytes < 0) throw new RangeError("View byte limit exceeded.");
}
function copyData(
  value: unknown,
  budget: DataBudget,
  depth = 0,
  ancestors = new Set<object>(),
): unknown {
  if (depth > budget.depth) {
    throw new RangeError("View data depth limit exceeded.");
  }
  if (--budget.nodes < 0) throw new RangeError("View node limit exceeded.");
  if (value === undefined) {
    chargeBytes(budget, "null");
    return undefined;
  }
  if (
    value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    chargeBytes(budget, JSON.stringify(value));
    return value;
  }
  if (typeof value === "string") {
    if (value.length > budget.bytes) {
      throw new RangeError("View byte limit exceeded.");
    }
    chargeBytes(budget, JSON.stringify(value));
    return value;
  }
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new TypeError("View data must be inert and acyclic.");
  }
  const array = Array.isArray(value);
  if (
    !array && ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("View data must use plain objects.");
  }
  const keys = Reflect.ownKeys(value);
  if (array && value.length > budget.nodes) {
    throw new RangeError("View node limit exceeded.");
  }
  if (keys.length - (array ? 1 : 0) > budget.nodes) {
    throw new RangeError("View node limit exceeded.");
  }
  chargeBytes(budget, array ? "[]" : "{}");
  ancestors.add(value);
  try {
    const result: Record<string, unknown> | unknown[] = array
      ? []
      : Object.create(null);
    let count = 0;
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== "string" || !descriptor.enumerable ||
        !("value" in descriptor) ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        (array && key !== String(count))
      ) {
        throw new TypeError("Unsafe View data property.");
      }
      if (count++) chargeBytes(budget, ",");
      if (!array) {
        if (key.length > budget.bytes) {
          throw new RangeError("View byte limit exceeded.");
        }
        chargeBytes(budget, JSON.stringify(key) + ":");
      }
      (result as Record<string, unknown>)[key] = copyData(
        descriptor.value,
        budget,
        depth + 1,
        ancestors,
      );
    }
    if (array && count !== value.length) {
      throw new TypeError("View data must use dense arrays.");
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}
/** Copies bounded inert, acyclic data without evaluating accessors. */
export function snapshotViewData(
  value: unknown,
  limits: SnapshotLimits = {},
): unknown {
  return copyData(value, dataBudget(limits));
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
}
const textRenderer: OneShotViewRenderer = {
  open: () => ({
    async render(evaluate) {
      const result = await evaluate();
      return typeof result === "string" ? result : JSON.stringify(result) ?? "";
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
  const scope = snapshotViewData(options.scope);
  const resources = snapshotViewData(
    options.resources ?? {},
  ) as ViewContext["resources"];
  const renderers: Readonly<Record<string, OneShotViewRenderer>> = {
    text: textRenderer,
    ...options.renderers,
  };
  const actions = Object.fromEntries(
    Object.keys(options.actions ?? {}).map((name) => [name, () => {
      throw new TypeError(
        "Actions are unavailable during pure one-shot View rendering.",
      );
    }]),
  );
  const renderer: TextViewRenderer = {
    async render(
      rawReference,
      requested = {},
      externalSignal = new AbortController().signal,
    ) {
      externalSignal.throwIfAborted();
      const lifetime = new AbortController();
      const signal = AbortSignal.any([externalSignal, lifetime.signal]);
      const exposedSignal = AbortSignal.any([signal]);
      let session: ReturnType<OneShotViewRenderer["open"]> | undefined;
      try {
        if (
          !rawReference || typeof rawReference !== "object" ||
          ![Object.prototype, null].includes(
            Object.getPrototypeOf(rawReference),
          )
        ) {
          throw new TypeError("View reference must be a plain object.");
        }
        const descriptors = Object.getOwnPropertyDescriptors(rawReference);
        if (
          Reflect.ownKeys(rawReference).some((key) =>
            typeof key !== "string" ||
            !["shows", "value"].includes(key) || !("value" in descriptors[key])
          ) ||
          !descriptors.shows || !descriptors.value
        ) {
          throw new TypeError("Unsafe View reference property.");
        }
        const reference: ViewReference = {
          shows: snapshotViewData(descriptors.shows.value) as ViewShows,
          value: descriptors.value.value,
        };
        viewShowsKey(reference.shows);
        const copiedHints = snapshotViewData(requested) as ViewHints;
        const hints = {
          mode: viewText(copiedHints.mode ?? "context", "View mode"),
          renderer: viewText(copiedHints.renderer ?? "text", "View renderer"),
        };
        const adapter = Object.hasOwn(renderers, hints.renderer)
          ? renderers[hints.renderer]
          : undefined;
        if (!adapter) {
          throw new TypeError(`No one-shot renderer '${hints.renderer}'.`);
        }
        const hostContext = {
          scope: snapshotViewData(scope),
          signal: exposedSignal,
        };
        const read = async (invoke: () => unknown | Promise<unknown>) => {
          signal.throwIfAborted();
          const value = await abortable(
            Promise.resolve().then(() => {
              signal.throwIfAborted();
              return invoke();
            }),
            signal,
          );
          signal.throwIfAborted();
          return snapshotViewData(value);
        };
        const projected = await read(() =>
          options.project(reference, hostContext)
        );
        const view = options.registry.resolveView(
          reference.shows,
          hints.mode,
          hints.renderer,
        );
        const collections = Object.fromEntries(
          Object.entries(options.collections ?? {}).map((
            [name, collection],
          ) => [name, {
            get: (input: unknown) => read(() => collection.get(input)),
            list: (input: unknown) => read(() => collection.list(input)),
            ...(collection.query
              ? {
                query: (
                  name: string,
                  input: Readonly<Record<string, unknown>>,
                ) => read(() => collection.query!(name, input)),
              }
              : {}),
          }]),
        ) as ViewCollections;
        const context: ViewContext = {
          collections,
          actions: { ...actions },
          resources: snapshotViewData(resources) as ViewContext["resources"],
          scope: snapshotViewData(scope),
          signal: exposedSignal,
          hints: { ...hints },
          show: async (nested, next = {}) => {
            signal.throwIfAborted();
            return await renderer.render(nested, {
              ...hints,
              ...snapshotViewData(next) as ViewHints,
            }, signal);
          },
        };
        session = adapter.open(hostContext);
        let evaluated = false;
        const result = await abortable(
          Promise.resolve(session.render(async () => {
            signal.throwIfAborted();
            if (evaluated) {
              throw new TypeError("A one-shot renderer cannot evaluate twice.");
            }
            evaluated = true;
            return await read(() =>
              view
                ? view.render(projected as never, context as never)
                : projected
            );
          })),
          signal,
        );
        signal.throwIfAborted();
        if (typeof result !== "string") {
          throw new TypeError("One-shot renderer must return text.");
        }
        return snapshotViewData(result) as string;
      } finally {
        lifetime.abort(new Error("View render lifetime ended."));
        if (session?.dispose) await session.dispose();
      }
    },
  };
  return renderer;
}

/** Interactive host port. Framework implementations belong to plugins. */
export interface ViewRendererAdapter {
  readonly id: string;
  mount(target: unknown, output: {
    getSnapshot(): unknown;
    subscribe(listener: () => void): () => void;
  }): { dispose(): void };
}
