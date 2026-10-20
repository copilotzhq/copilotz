import { createViewResolver } from "../../runtime/views/resolution.ts";
import { resolveContributions } from "../../runtime/plugins/contribution.ts";
import type {
  ViewHints,
  ViewMap,
  ViewReference,
} from "../../runtime/views/definition.ts";
import { readKey, type ReadRequest, type Row } from "./reads.ts";
import {
  createLiveQuery,
  type LiveQuery,
  type OperationResult,
} from "../live-query.ts";
import type { SubscriptionFrame } from "../../runtime/subscriptions/types.ts";
import type { CollectionQuery } from "../../runtime/collections/types.ts";
import type {
  ActionHandle,
  ActionStatus,
  BrowserActionContext,
  BrowserActionDefinition,
  BrowserPlugin,
  BrowserRuntime,
  BrowserRuntimeOptions,
  BrowserViewContext,
  ClientCollection,
  ClientCollectionDefinition,
  ClientEvent,
  Observation,
  ReadState,
} from "./types.ts";

type Entry = {
  request: ReadRequest;
  live?: LiveQuery;
  close?: () => void;
};
type Layer = {
  id: string;
  collection: string;
  record: string;
  command: string;
  input: unknown;
};
type Watch = { dependencies: Set<string>; run(): void; dispose(): void };
const clone = <T>(value: T): T => structuredClone(value);
function immutable<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return value;
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function sequence(seq: number | string): void {
  if (
    typeof seq === "string"
      ? !/^(0|[1-9][0-9]*)$/.test(seq)
      : !Number.isSafeInteger(seq) || seq < 0
  ) {
    throw new TypeError("Invalid owner sequence");
  }
}

/** One browser host, using the existing View resolution and contribution mechanism. */
export async function createBrowserRuntime(
  options: BrowserRuntimeOptions,
): Promise<BrowserRuntime> {
  const lifetime = new AbortController();
  const definitions: Record<string, ClientCollectionDefinition> = Object.create(
    null,
  );
  const actionDefinitions: Record<string, BrowserActionDefinition> = Object
    .create(null);
  const processors: NonNullable<BrowserPlugin["processors"]>[string][] = [];
  const processorAliases: Record<string, unknown> = Object.create(null);
  const views: Record<string, ViewMap[string]> = Object.create(null);
  const resources: Record<string, Record<string, unknown>> = Object.create(
    null,
  );
  const adapters: Record<string, Record<string, unknown>> = Object.create(null);
  const visited = new Map<string, BrowserPlugin>();
  const visiting = new Set<string>();
  function merge(target: Record<string, unknown>, source: object | undefined) {
    for (const [key, value] of Object.entries(source ?? {})) {
      if (
        ["__proto__", "constructor", "prototype"].includes(key) ||
        Object.hasOwn(target, key)
      ) throw new TypeError(`Duplicate or unsafe primitive '${key}'`);
      target[key] = value;
    }
  }
  function compose(plugin: BrowserPlugin) {
    if (visiting.has(plugin.id)) {
      throw new TypeError(`Plugin cycle '${plugin.id}'`);
    }
    if (visited.has(plugin.id)) {
      if (visited.get(plugin.id) !== plugin) {
        throw new TypeError(`Duplicate plugin '${plugin.id}'`);
      }
      return;
    }
    visiting.add(plugin.id);
    for (const dependency of plugin.plugins ?? []) compose(dependency);
    // Only resources/adapters/Views use the generic expansion; browser primitives
    // retain their placement contracts rather than impersonating server executables.
    const expanded = resolveContributions({
      views: plugin.views,
      resources: plugin.resources,
      adapters: plugin.adapters,
    });
    if (
      Object.keys(expanded.actions).length ||
      Object.keys(expanded.collections).length ||
      Object.keys(expanded.processors).length || expanded.plugins.length
    ) {
      throw new TypeError(
        "Browser contributions must emit browser-safe Views/resources/adapters; declare executable primitives on the plugin",
      );
    }
    merge(definitions, plugin.collections);
    merge(actionDefinitions, plugin.actions);
    merge(views, expanded.views);
    merge(processorAliases, plugin.processors);
    for (const processor of Object.values(plugin.processors ?? {})) {
      if (processor.placement !== "server") processors.push(processor);
    }
    for (
      const [target, source] of [[resources, expanded.resources], [
        adapters,
        expanded.adapters,
      ]] as const
    ) {
      for (const [namespace, entries] of Object.entries(source)) {
        Object.assign(target[namespace] ??= Object.create(null), entries);
      }
    }
    visiting.delete(plugin.id);
    visited.set(plugin.id, plugin);
  }
  for (const plugin of options.plugins) compose(plugin);
  for (const [namespace, values] of Object.entries(options.adapters ?? {})) {
    Object.assign(adapters[namespace] ??= Object.create(null), values);
  }
  const grantedAdapters = Object.freeze(
    Object.fromEntries(
      Object.entries(adapters).map((
        [namespace, values],
      ) => [namespace, Object.freeze({ ...values })]),
    ),
  );
  const resolve = createViewResolver(views, resources.views?.prefer);
  const local = new Map<string, readonly Row[]>();
  const writes = new Map<string, Promise<void>>();
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.placement === "browser") {
      const storage = definition.storage &&
        options.storage?.[definition.storage];
      if (definition.storage && !storage) {
        throw new TypeError(`Missing storage '${definition.storage}'`);
      }
      const rows = (storage ? await storage.load(name) : undefined) ??
        definition.initial ?? [];
      if (
        rows.some((row) => typeof row.id !== "string" || !row.id) ||
        new Set(rows.map((row) => row.id)).size !== rows.length
      ) throw new TypeError("Invalid rows");
      local.set(name, clone(rows));
    }
  }
  const entries = new Map<string, Entry>();
  const pendingLayers = new Map<
    string,
    { layer: Layer; result: Promise<OperationResult> }
  >();
  const queries = new Map<
    string,
    {
      alias: string;
      input: unknown;
      value: ReadState;
      generation: number;
      controller: AbortController;
      start(): void;
    }
  >();
  const watches = new Set<Watch>();
  const events: ClientEvent[] = [];
  const eventListeners = new Set<(event: ClientEvent) => void>();
  let tracking: Set<string> | undefined;
  let rendering = 0;
  let notifying = false;
  const changed = new Set<string>();
  const report = (error: unknown) => {
    try {
      options.onError?.(error);
    } catch { /* Error reporting cannot break another observer. */ }
  };
  function alive() {
    lifetime.signal.throwIfAborted();
  }
  function notify(key: string) {
    changed.add(key);
    if (notifying) return;
    notifying = true;
    try {
      while (changed.size) {
        const keys = new Set(changed);
        changed.clear();
        for (const watch of [...watches]) {
          if ([...keys].some((key) => watch.dependencies.has(key))) watch.run();
        }
      }
    } finally {
      notifying = false;
    }
  }
  function emit(type: string, collection?: string, id?: string) {
    if (lifetime.signal.aborted) return;
    const event = Object.freeze({
      index: (events.at(-1)?.index ?? 0) + 1,
      type,
      ...(collection ? { collection } : {}),
      ...(id ? { id } : {}),
    });
    events.push(event);
    if (events.length > 1000) events.shift();
    for (const listener of eventListeners) {
      try {
        listener(event);
      } catch (error) {
        report(error);
      }
    }
    for (const processor of processors) {
      if (processor.on === type) {
        try {
          Promise.resolve(processor.handle(event, actionContext())).catch(
            report,
          );
        } catch (error) {
          report(error);
        }
      }
    }
  }
  function invalidateCollection(name: string) {
    for (const [key, entry] of entries) {
      if (entry.request.collection === name) notify(key);
    }
  }
  function applied(
    entry: Entry,
    frame: SubscriptionFrame | undefined,
    key: string,
  ) {
    if (!frame && entry.live?.status === "denied") {
      frame = { t: "revoked", reason: "authorization" };
    }
    notify(key);
    if (
      frame?.t === "batch" &&
        (frame.collectionChanged ?? frame.changes.length > 0) ||
      frame?.t === "reset" ||
      frame?.t === "revoked"
    ) {
      for (const [queryKey, query] of queries) {
        if (
          actionDefinitions[query.alias].query?.reads.includes(
            entry.request.collection,
          )
        ) {
          if (frame?.t === "revoked") {
            query.generation++;
            query.controller.abort();
            query.value = {
              value: undefined,
              status: "denied",
              pending: false,
            };
            notify(queryKey);
          } else query.start();
        }
      }
    }
    // Initial/replacement snapshots and restore are not live processor events.
    if (frame?.t === "batch") {
      const ids = new Set([
        ...frame.changes.map((change) => change.id),
      ]);
      for (const id of ids) {
        emit("collection.changed", entry.request.collection, id);
      }
    }
  }
  function entryFor(request: ReadRequest): [string, Entry] {
    alive();
    const key = readKey(request);
    tracking?.add(key);
    let entry = entries.get(key);
    if (!entry) {
      entry = { request: clone(request) };
      entries.set(key, entry);
      if (!local.has(request.collection)) {
        if (!options.live) {
          throw new TypeError(
            `No live-read transport for '${request.collection}'`,
          );
        }
        const target = entry;
        const query = request.id === undefined
          ? request.query ?? {}
          : { where: { id: request.id }, limit: 1 };
        target.live = createLiveQuery(
          options.live,
          request.collection,
          query as CollectionQuery,
          {
            signal: lifetime.signal,
            content: request.content,
            onState: (frame) => {
              if (!lifetime.signal.aborted) applied(target, frame, key);
            },
          },
        );
        target.close = () => target.live!.close();
        void target.live.done.catch((error) => {
          if (!lifetime.signal.aborted) report(error);
        });
        for (const [id, pending] of pendingLayers) {
          if (pending.layer.collection === request.collection) {
            target.live.optimistic(id, pending.layer, pending.result);
          }
        }
      }
    }
    return [key, entry];
  }
  function patch(
    row: Row,
    collection: string,
    command: string,
    input: unknown,
  ): Row {
    const mutate = definitions[collection]?.commands?.[command]?.mutate;
    if (!mutate) {
      throw new TypeError(`Unknown command '${collection}.${command}'`);
    }
    const delta = mutate({
      current: immutable(clone(row)),
      input: clone(input),
    });
    const next = { ...row, ...delta?.set };
    for (const key of delta?.unset ?? []) delete next[key];
    if (next.id !== row.id) {
      throw new TypeError("Commands cannot change record identity");
    }
    return next;
  }
  function matches(
    row: Row,
    query?: Readonly<Record<string, unknown>>,
  ): boolean {
    const where = query?.where as Record<string, unknown> | undefined;
    return !where ||
      Object.entries(where).every(([key, value]) => row[key] === value);
  }
  function read(request: ReadRequest): ReadState<readonly Row[]> {
    const [, entry] = entryFor(request);
    let rows = local.has(request.collection)
      ? [...local.get(request.collection)!]
      : [...entry.live!.rows];
    let pending = false;
    if (entry.live?.status !== "denied") {
      for (const value of entry.live?.optimisticLayers.values() ?? []) {
        const layer = value as Layer;
        if (
          layer.collection !== request.collection
        ) continue;
        if (request.id !== undefined && layer.record !== request.id) continue;
        const index = rows.findIndex((row) => row.id === layer.record);
        // Membership and window refill belong to the server. A command only
        // overlays a row already present in this authorized projection.
        if (index < 0) continue;
        const next = patch(
          rows[index],
          layer.collection,
          layer.command,
          layer.input,
        );
        pending = true;
        rows[index] = next;
      }
    }
    if (request.id !== undefined) {
      rows = rows.filter((row) => row.id === request.id);
    }
    if (local.has(request.collection)) {
      rows = rows.filter((row) => matches(row, request.query));
      if (typeof request.query?.limit === "number") {
        rows = rows.slice(0, request.query.limit);
      }
    }
    return immutable(
      clone({
        value: rows,
        status: local.has(request.collection)
          ? "ready" as const
          : entry.live!.status,
        pending,
      }),
    );
  }
  const collections: Record<string, ClientCollection> = Object.create(null);
  for (const name of Object.keys(definitions)) {
    collections[name] = Object.freeze({
      get(id: string, options?: Pick<ReadRequest, "content">) {
        const state = read({ collection: name, id, ...options });
        return {
          ...state,
          value: state.value[0],
          status: state.status === "ready" && !state.value.length
            ? "missing" as const
            : state.status,
        };
      },
      list(
        query?: Readonly<Record<string, unknown>>,
        options?: Pick<ReadRequest, "content">,
      ) {
        return read({
          collection: name,
          ...(query ? { query } : {}),
          ...options,
        });
      },
    });
  }
  function command(
    collection: string,
    id: string,
    name: string,
    input: unknown,
  ) {
    alive();
    if (rendering) throw new TypeError("Views cannot mutate during render");
    const rows = local.get(collection);
    if (!rows) throw new TypeError("Server Collections are read-only");
    const index = rows.findIndex((row) => row.id === id);
    const next = [...rows];
    const row = patch(rows[index] ?? { id }, collection, name, input);
    if (index < 0) next.push(row);
    else next[index] = row;
    local.set(collection, next);
    const storageName = definitions[collection].storage;
    if (storageName) {
      const write = (writes.get(collection) ?? Promise.resolve()).catch(
        () => {},
      ).then(() => options.storage![storageName].save(collection, clone(next)));
      writes.set(collection, write);
      write.catch(report);
    }
    invalidateCollection(collection);
    emit("collection.changed", collection, id);
  }
  const actions: Record<string, (input: unknown) => ActionHandle> = Object
    .create(null);
  for (const [alias, definition] of Object.entries(actionDefinitions)) {
    actions[alias] = (input) => {
      alive();
      const invocation = clone(input);
      if (rendering) {
        throw new TypeError("Views cannot invoke Actions during render");
      }
      const id = crypto.randomUUID();
      const controller = new AbortController();
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      let status: ActionStatus = "pending",
        error: unknown,
        operation: string | undefined;
      let acceptOperation!: (id: string | undefined) => void;
      const receipt = new Promise<string | undefined>((resolve) => {
        acceptOperation = resolve;
      });
      let cancellation: Promise<void> | undefined;
      const transition = (next: ActionStatus) => {
        status = next;
        notify(`action:${id}`);
        emit(`action.${next}`, undefined, id);
      };
      const settlement = Promise.withResolvers<OperationResult>();
      void settlement.promise.catch(() => {});
      if (definition.optimistic) {
        const optimistic = definition.optimistic;
        const layer = {
          id,
          collection: optimistic.collection,
          record: optimistic.id(clone(invocation)),
          command: optimistic.command,
          input: clone(
            optimistic.input ? optimistic.input(clone(invocation)) : invocation,
          ),
        };
        if (!definitions[layer.collection]?.commands?.[layer.command]) {
          throw new TypeError(
            `Unknown optimistic command '${layer.collection}.${layer.command}'`,
          );
        }
        pendingLayers.set(id, { layer, result: settlement.promise });
        for (const entry of entries.values()) {
          if (entry.request.collection === layer.collection) {
            entry.live?.optimistic(id, layer, settlement.promise);
          }
        }
      }
      const result = Promise.resolve().then(async () => {
        signal.throwIfAborted();
        transition("running");
        if (definition.placement !== "server") {
          if (!definition.execute) {
            throw new TypeError(`Missing browser execute '${definition.id}'`);
          }
          const value = await definition.execute(
            invocation,
            actionContext(signal),
          );
          signal.throwIfAborted();
          settlement.resolve({ value, seq: "0" });
          transition("completed");
          return value;
        }
        if (!options.actions) throw new TypeError("No Action transport");
        const terminal = await options.actions.invoke(
          definition.id,
          invocation,
          {
            idempotencyKey: id,
            signal,
            accepted(operationId) {
              operation = operationId;
              acceptOperation(operationId);
            },
          },
        );
        signal.throwIfAborted();
        sequence(terminal.seq);
        settlement.resolve({
          value: terminal.value,
          seq: String(terminal.seq),
        });
        transition("completed");
        return terminal.value;
      }).catch((cause) => {
        error = cause;
        settlement.reject(cause);
        transition(signal.aborted ? "cancelled" : "failed");
        throw cause;
      }).finally(() => {
        pendingLayers.delete(id);
        acceptOperation(undefined);
      });
      // Handles are observable even when the caller deliberately ignores result().
      result.catch(() => {});
      const handle: ActionHandle = {
        id,
        get status() {
          tracking?.add(`action:${id}`);
          return status;
        },
        get error() {
          tracking?.add(`action:${id}`);
          return error;
        },
        result: () => result,
        async cancel() {
          if (["completed", "failed", "cancelled"].includes(status)) return;
          if (definition.placement !== "server") {
            controller.abort(new Error("Action cancelled"));
            return;
          }
          const operationId = operation ?? await receipt;
          if (
            !operationId ||
            ["completed", "failed", "cancelled"].includes(status)
          ) return;
          if (operationId) {
            try {
              await (cancellation ??= options.actions!.cancel(operationId));
            } catch (cause) {
              cancellation = undefined;
              error = cause;
              notify(`action:${id}`);
              throw cause;
            }
          }
        },
      };
      return handle;
    };
  }
  Object.freeze(collections);
  Object.freeze(actions);
  function readAction(alias: string, input: unknown): ReadState {
    alive();
    const definition = actionDefinitions[alias];
    if (!definition?.query || definition.placement !== "server") {
      throw new TypeError(`Action '${alias}' is not a query`);
    }
    if (!options.actions) throw new TypeError("No Action transport");
    const key = `query:${readKey({ collection: alias, query: { input } })}`;
    tracking?.add(key);
    let denied = false;
    for (const name of definition.query.reads) {
      const state = collections[name]?.list({ limit: 1 });
      if (!state) throw new TypeError(`Unknown query dependency '${name}'`);
      if (state.status === "denied") denied = true;
    }
    if (denied) return { value: undefined, status: "denied", pending: false };
    let query = queries.get(key);
    if (!query) {
      query = {
        alias,
        input: clone(input),
        value: { value: undefined, status: "loading", pending: false },
        generation: 0,
        controller: new AbortController(),
        start() {
          const generation = ++this.generation;
          this.controller.abort();
          this.controller = new AbortController();
          const signal = AbortSignal.any([
            lifetime.signal,
            this.controller.signal,
          ]);
          this.value = {
            ...this.value,
            status: this.value.value === undefined ? "loading" : "stale",
          };
          // Defer submission until dependency tracking is installed; no render-time writes.
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return options.actions!.invoke(definition.id, this.input, {
              idempotencyKey: crypto.randomUUID(),
              signal,
              accepted() {},
            });
          }).then((result) => {
            if (signal.aborted || generation !== this.generation) return;
            this.value = immutable(
              clone({
                value: result.value,
                status: "ready" as const,
                pending: false,
              }),
            );
            notify(key);
          }, (error) => {
            if (signal.aborted || generation !== this.generation) return;
            this.value = { value: undefined, status: "denied", pending: false };
            report(error);
            notify(key);
          });
        },
      };
      queries.set(key, query);
      query.start();
    }
    return query.value;
  }
  function context(hints: ViewHints = {}): BrowserViewContext {
    return {
      collections,
      actions,
      adapters: grantedAdapters,
      readAction,
      resources: immutable(clone(resources)),
      scope: immutable(clone(options.scope)),
      signal: lifetime.signal,
      hints: {
        ...hints,
        mode: hints.mode ?? "full",
        renderer: hints.renderer ?? options.renderer?.id ?? "default",
      },
      show(reference, next = {}) {
        alive();
        const combined = { ...hints, ...next };
        if (
          combined.region !== undefined || combined.source !== undefined
        ) return options.show?.(reference, combined);
        return render(reference, combined);
      },
    };
  }
  function actionContext(signal = lifetime.signal): BrowserActionContext {
    return {
      ...context(),
      signal,
      command(...args) {
        signal.throwIfAborted();
        command(...args);
      },
    };
  }
  function render(reference: ViewReference, hints: ViewHints = {}): unknown {
    alive();
    const ctx = context(hints);
    const view = resolve(reference.shows, ctx.hints.mode, ctx.hints.renderer);
    if (!view) {
      throw new TypeError(
        `No View for ${JSON.stringify(reference.shows)} (${ctx.hints.mode})`,
      );
    }
    rendering++;
    try {
      const output = view.render(
        immutable(clone(reference.value)) as never,
        ctx as never,
      );
      if (output && typeof output === "object" && "then" in output) {
        throw new TypeError(
          "Browser View render must be synchronous for tracked reads",
        );
      }
      return output;
    } finally {
      rendering--;
    }
  }
  function releaseUnused() {
    for (const [key, query] of queries) {
      if (![...watches].some((watch) => watch.dependencies.has(key))) {
        query.controller.abort();
        queries.delete(key);
      }
    }
    for (const [key, entry] of entries) {
      if ([...watches].some((watch) => watch.dependencies.has(key))) continue;
      entry.close?.();
      entries.delete(key);
    }
  }
  function observe<T>(
    evaluate: (ctx: BrowserViewContext) => T,
  ): Observation<T> {
    alive();
    let value: T;
    let disposed = false;
    let failure: unknown;
    let running = false;
    const listeners = new Set<() => void>();
    const watch: Watch = {
      dependencies: new Set(),
      run() {
        if (disposed || running) return;
        running = true;
        const previous = tracking;
        tracking = new Set();
        try {
          value = evaluate(context());
          failure = undefined;
        } catch (error) {
          failure = error;
        } finally {
          watch.dependencies = tracking;
          tracking = previous;
          running = false;
        }
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch (error) {
            report(error);
          }
        }
        releaseUnused();
      },
      dispose() {
        disposed = true;
        watches.delete(watch);
        listeners.clear();
        releaseUnused();
      },
    };
    watches.add(watch);
    watch.run();
    return {
      getSnapshot() {
        alive();
        if (disposed) throw new TypeError("Observation disposed");
        if (failure) throw failure;
        return value;
      },
      subscribe(listener) {
        if (disposed) throw new TypeError("Observation disposed");
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: watch.dispose,
    };
  }
  const mounted = new Set<{ dispose(): void }>();
  const runtime = {
    collections,
    actions,
    render,
    observe,
    get events(): readonly ClientEvent[] {
      return [...events];
    },
    onEvent(listener: (event: ClientEvent) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async flushStorage() {
      await Promise.all(writes.values());
    },
    mount(target: unknown, root: ViewReference, hints?: ViewHints) {
      alive();
      if (!options.renderer) throw new TypeError("No renderer adapter");
      const output = observe(() => render(root, hints));
      let session: { dispose(): void };
      try {
        session = options.renderer.mount(target, output);
      } catch (error) {
        output.dispose();
        throw error;
      }
      const mount = {
        dispose() {
          session.dispose();
          output.dispose();
          mounted.delete(mount);
        },
      };
      mounted.add(mount);
      return mount;
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort(new Error("Browser runtime disposed"));
      for (const mount of [...mounted]) mount.dispose();
      for (const watch of [...watches]) watch.dispose();
      for (const entry of entries.values()) entry.close?.();
      entries.clear();
      pendingLayers.clear();
      for (const query of queries.values()) query.controller.abort();
      queries.clear();
      local.clear();
      events.length = 0;
      eventListeners.clear();
    },
  };
  emit("app.started");
  return runtime;
}
export type { BrowserRuntime } from "./types.ts";
