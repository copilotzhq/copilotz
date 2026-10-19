/** Private bounded evaluation of an already-authorized preparation snapshot.
 * This grants no read or capture authority. Its caller owns authorization,
 * original-reference provenance and the child event/body transaction. */
import type { PluginRegistry } from "../plugins/registry.ts";
import { createTextRenderer } from "../views/renderer.ts";
import { viewShowsKey, viewText } from "../views/definition.ts";
import type { ViewHints, ViewShows } from "../views/definition.ts";
import { assertJsonValue } from "../json.ts";
import type { CommandJson } from "../engine/commands.ts";

export type PreparedViewSelection =
  | Readonly<{ kind: "registered"; id: string }>
  | Readonly<{ kind: "generic" }>;
export type PreparationRenderResult = Readonly<{
  input: CommandJson;
  selection: PreparedViewSelection;
  hints: Readonly<{ mode: string; renderer: "text" }>;
}>;
export type ActionPreparationRenderer = Readonly<{
  render(
    input: Readonly<{
      shows: ViewShows;
      hints?: ViewHints;
      data: CommandJson;
      resources: Readonly<
        Record<string, Readonly<Record<string, CommandJson>>>
      >;
      scope: CommandJson;
      signal: AbortSignal;
      /** Registered owner-local code only, never a worker-supplied closure. */
      mapInput(
        text: string,
        context: Readonly<{
          selection: PreparedViewSelection;
          hints: Readonly<{ mode: string; renderer: "text" }>;
          signal: AbortSignal;
        }>,
      ): CommandJson | Promise<CommandJson>;
    }>,
  ): Promise<PreparationRenderResult>;
  snapshot(): Readonly<{ pending: number }>;
}>;
function error(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function bound(value: number | undefined, fallback: number, maximum: number) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) {
    throw error("preparation_invalid");
  }
  return result;
}
function identity(value: unknown, label: string): string {
  const result = viewText(value, label);
  if (result.length > 512) throw error("preparation_limit");
  return result;
}
function snapshot(value: unknown, maxBytes: number): CommandJson {
  assertJsonValue(value, { maxDepth: 32, maxNodes: 20_000 });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
    throw error("preparation_limit");
  }
  return structuredClone(value) as CommandJson;
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createPreparationRenderer(
  options: Readonly<{
    registry: Pick<PluginRegistry, "resolveView">;
    maxPending?: number;
    timeoutMs?: number;
    maxBytes?: number;
  }>,
): ActionPreparationRenderer {
  const resolveView = options.registry.resolveView.bind(options.registry);
  const maxPending = bound(options.maxPending, 16, 128);
  const timeoutMs = bound(options.timeoutMs, 1000, 10_000);
  const maxBytes = bound(options.maxBytes, 65_536, 1_048_576);
  let pending = 0;
  return {
    async render(input) {
      input.signal.throwIfAborted();
      if (pending >= maxPending) throw error("preparation_busy");
      const detached = snapshot({
        shows: input.shows,
        hints: input.hints ?? {},
        data: input.data,
        resources: input.resources,
        scope: input.scope,
      }, maxBytes) as {
        shows: ViewShows;
        hints: ViewHints;
        data: CommandJson;
        resources: Record<string, Record<string, CommandJson>>;
        scope: CommandJson;
      };
      const hints = {
        mode: identity(
          detached.hints.mode ?? "channel",
          "Preparation View mode",
        ),
        renderer: "text" as const,
      };
      if ((detached.hints.renderer ?? "text") !== "text") {
        throw error("preparation_renderer_unavailable");
      }
      const { data, resources, scope, shows } = detached;
      viewShowsKey(shows);
      identity(
        typeof shows === "string" ? shows : Object.values(shows)[0],
        "Preparation View shows",
      );
      const selected = resolveView(shows, hints.mode, hints.renderer);
      const selection: PreparedViewSelection = selected
        ? {
          kind: "registered",
          id: identity(selected.id, "Preparation View id"),
        }
        : { kind: "generic" };
      snapshot({ data, resources, scope, shows, hints, selection }, maxBytes);
      const evaluate = selected?.render.bind(selected);
      const mapInput = input.mapInput;
      const lifetime = new AbortController();
      const signal = AbortSignal.any([input.signal, lifetime.signal]);
      const timer = setTimeout(
        () => lifetime.abort(error("preparation_timeout")),
        timeoutMs,
      );
      const actual = new Set<Promise<unknown>>();
      let open = true;
      let released = false;
      let refusal: string | undefined;
      pending++;
      const release = () => {
        if (!open && !actual.size && !released) {
          released = true;
          pending--;
        }
      };
      const check = () => {
        if (!open) throw error("preparation_closed");
        signal.throwIfAborted();
        if (refusal) throw error(refusal);
      };
      const track = <T>(run: () => T | Promise<T>): Promise<T> => {
        const work = Promise.resolve().then(() => {
          check();
          return run();
        });
        actual.add(work);
        const settled = () => {
          actual.delete(work);
          release();
        };
        work.then(settled, settled);
        return work;
      };
      try {
        check();
        const renderer = createTextRenderer({
          registry: {
            resolveView: () =>
              selected && evaluate
                ? {
                  ...selected,
                  render: (item, context) =>
                    track(async () => {
                      const result = await evaluate(item, {
                        ...context,
                        collections: new Proxy({}, {
                          get() {
                            refusal ??= "preparation_read_unavailable";
                            throw error(refusal);
                          },
                        }),
                        show: (_reference, _childHints) => {
                          refusal ??= "preparation_nested_unavailable";
                          return Promise.reject(error(refusal));
                        },
                      });
                      check();
                      return result;
                    }),
                }
                : undefined,
          },
          project: () => {
            check();
            return structuredClone(data);
          },
          resources,
          scope,
          maxDepth: 32,
          // The public renderer charges cumulative internal snapshots. Each
          // named input/output envelope still has the stricter local budget.
          maxNodes: 160_000,
          maxBytes: maxBytes * 8,
          maxPending: 1,
          timeoutMs,
        });
        const rendered = await renderer.render(
          { shows, value: null },
          hints,
          signal,
        );
        check();
        snapshot(rendered, maxBytes);
        const mapped = await abortable(
          track(() =>
            mapInput(rendered, {
              selection: structuredClone(selection),
              hints: { ...hints },
              // Never expose the signal read by private lifetime enforcement.
              signal: AbortSignal.any([signal]),
            })
          ),
          signal,
        );
        check();
        return snapshot({
          input: snapshot(mapped, maxBytes),
          selection: structuredClone(selection),
          hints: { ...hints },
        }, maxBytes) as PreparationRenderResult;
      } finally {
        open = false;
        clearTimeout(timer);
        lifetime.abort(error("preparation_closed"));
        // An abortable render wrapper can finish before actual user code.
        // Keep its finite occupancy until every real View/mapper promise settles.
        release();
      }
    },
    snapshot: () => ({ pending }),
  };
}
