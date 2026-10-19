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
  /** Maximum nested View and data depth (default 32). */
  maxDepth?: number;
  /** Cumulative nodes and UTF-8 bytes across a root render and its children. */
  maxNodes?: number;
  maxBytes?: number;
  /** Concurrent render sessions and collection reads; excess work rejects without queuing. */
  maxPending?: number;
  /** Root deadline, including nested rendering and cleanup (default 1000ms). */
  timeoutMs?: number;
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
  const limits = dataBudget(options);
  const maxPending = positiveBound(options.maxPending ?? 16, "pending");
  const timeoutMs = positiveBound(options.timeoutMs ?? 1_000, "timeout");
  if (timeoutMs > 2_147_483_647) {
    throw new TypeError("Invalid View timeout bound.");
  }
  const scope = copyData(options.scope, dataBudget(options));
  const resources = copyData(
    options.resources ?? {},
    dataBudget(options),
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
  let pending = 0;
  function reserve(): () => void {
    if (pending >= maxPending) {
      throw new RangeError("View pending capacity exceeded.");
    }
    pending++;
    return () => {
      pending--;
    };
  }
  return ({
    async render(
      reference,
      hints = {},
      externalSignal = new AbortController().signal,
    ): Promise<string> {
      externalSignal.throwIfAborted();
      const deadline = new AbortController();
      const rootSignal = AbortSignal.any([externalSignal, deadline.signal]);
      const timer = setTimeout(
        () => deadline.abort(new Error("View rendering timed out.")),
        timeoutMs,
      );
      const budget = { ...limits };
      const render = async (
        rawReference: ViewReference,
        requested: ViewHints,
        depth: number,
        parentSignal: AbortSignal,
      ): Promise<string> => {
        parentSignal.throwIfAborted();
        if (depth > limits.depth) {
          throw new RangeError("View nesting limit exceeded.");
        }
        const release = reserve();
        const lifetime = new AbortController();
        const signal = AbortSignal.any([parentSignal, lifetime.signal]);
        const exposedSignal = AbortSignal.any([signal]);
        const children = new Set<Promise<string>>();
        const physical = new Set<Promise<unknown>>();
        let finished = false;
        let released = false;
        const maybeRelease = () => {
          if (finished && physical.size === 0 && !released) {
            released = true;
            release();
          }
        };
        // Observe the original callback promises, never only their abort races.
        const track = <T>(invoke: () => T | Promise<T>): Promise<T> => {
          let work: Promise<T>;
          try {
            work = Promise.resolve(invoke());
          } catch (error) {
            work = Promise.reject(error);
          }
          physical.add(work);
          const settled = () => {
            physical.delete(work);
            maybeRelease();
          };
          work.then(settled, settled);
          return work;
        };
        let session: ReturnType<OneShotViewRenderer["open"]> | undefined;
        try {
          // Inspect selectors without executing getters. Raw values go only to
          // the trusted projector; only its authorized snapshot reaches the View.
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
              !["shows", "value"].includes(key) ||
              !("value" in descriptors[key])
            ) ||
            !descriptors.shows || !descriptors.value
          ) {
            throw new TypeError("Unsafe View reference property.");
          }
          const ref: ViewReference = {
            shows: copyData(descriptors.shows.value, budget) as ViewShows,
            value: descriptors.value.value,
          };
          viewShowsKey(ref.shows);
          const copiedHints = copyData(requested, budget) as ViewHints;
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
            scope: copyData(scope, budget),
            signal: exposedSignal,
          };
          const projected = copyData(
            await abortable(
              track(() => {
                signal.throwIfAborted();
                return options.project(ref, hostContext);
              }),
              signal,
            ),
            budget,
          );
          signal.throwIfAborted();
          const view = options.registry.resolveView(
            ref.shows,
            hints.mode,
            hints.renderer,
          );
          const read = async (
            invoke: () => Promise<unknown>,
          ): Promise<unknown> => {
            signal.throwIfAborted();
            const releaseRead = reserve();
            const work = track(() => {
              signal.throwIfAborted();
              return invoke();
            });
            work.then(releaseRead, releaseRead);
            const value = await abortable(work, signal);
            signal.throwIfAborted();
            return copyData(value, budget);
          };
          const collections = Object.fromEntries(
            Object.entries(options.collections ?? {}).map(
              ([name, collection]) => [name, {
                get: (input: unknown) => read(() => collection.get(input)),
                list: (input: unknown) => read(() => collection.list(input)),
              }],
            ),
          ) as ViewCollections;
          const context: ViewContext = {
            collections,
            actions: { ...actions },
            resources: copyData(resources, budget) as ViewContext["resources"],
            scope: copyData(scope, budget),
            signal: exposedSignal,
            hints: { ...hints },
            show: (nested, next = {}) => {
              // Snapshot before spreading: a nested selector cannot smuggle getters.
              const child = (async () => {
                signal.throwIfAborted();
                const nextHints = copyData(next, budget) as ViewHints;
                return await render(
                  nested,
                  { ...hints, ...nextHints },
                  depth + 1,
                  signal,
                );
              })();
              children.add(child);
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
            track(() => {
              signal.throwIfAborted();
              return currentSession.render(() => {
                signal.throwIfAborted();
                if (evaluated) {
                  throw new TypeError(
                    "A one-shot renderer cannot evaluate twice.",
                  );
                }
                evaluated = true;
                return track(async () => {
                  signal.throwIfAborted();
                  const value = view
                    ? await view.render(projected as never, context)
                    : projected;
                  signal.throwIfAborted();
                  return copyData(value, budget);
                });
              });
            }),
            signal,
          );
          signal.throwIfAborted();
          if (typeof result !== "string") {
            throw new TypeError("One-shot renderer must return text.");
          }
          chargeBytes(budget, result);
          return result;
        } finally {
          lifetime.abort(new Error("View render lifetime ended."));
          try {
            await abortable(Promise.allSettled([...children]), rootSignal);
          } finally {
            try {
              if (session?.dispose) {
                await abortable(track(() => session!.dispose!()), rootSignal);
              }
            } finally {
              finished = true;
              maybeRelease();
            }
          }
        }
      };
      try {
        return await render(reference, hints, 1, rootSignal);
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
