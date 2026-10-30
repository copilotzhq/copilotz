/**
 * Merges plugins into one registry of primitives. The owner and every
 * executor build the same registry from the same plugins.
 */
import { Validator } from "@cfworker/json-schema";
import type {
  ActionDef,
  Adapters,
  CollectionDef,
  Context,
  EventDef,
  Guard,
  Labels,
  Merged,
  Plugin,
  Plugins,
  ProcessorDef,
  ReadContext,
  Resources,
  Views,
  WorkerKind,
} from "./define.ts";
import type { ScheduleDef } from "./schedules.ts";

/** Everything crossing the runtime boundary is JSON: undefined fields disappear. */
export const json = <T>(value: T): T =>
  value === undefined ? value : JSON.parse(JSON.stringify(value));

export const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });

/** JSON with object keys sorted, so equal values serialize equally. */
export const canonical = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : v,
  );

/** A short hash identifying an action call by what it does: its action and input. */
export async function fingerprint(action: string, input: unknown): Promise<string> {
  const data = new TextEncoder().encode(canonical([action, input ?? null]));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function compile(schema: unknown, label: string): (value: unknown) => void {
  const validator = new Validator(schema as never, "2020-12", false);
  return (value: unknown) => {
    const result = validator.validate(value);
    if (!result.valid) {
      const first = result.errors.at(-1);
      throw invalid(`${label}: ${first?.error ?? "invalid"} (${first?.instanceLocation ?? "#"})`);
    }
  };
}

export type Registry = {
  collections: Record<string, CollectionDef>;
  actions: Record<string, ActionDef>;
  events: Record<string, EventDef>;
  processors: Record<string, ProcessorDef>;
  views: Views;
  resources: Resources;
  adapters: Adapters;
  schedules: Record<string, ScheduleDef>;
  /** The plugins' startup checks, run by `checked` once the runtime has what they ask. */
  checks: { name: string; check: NonNullable<Plugin["check"]> }[];
  /** Who reaches what: every plugin's rules, which restrict together. */
  guards: Guard[];
  /** What reads reveal to writes: the last plugin's. */
  labels?: Labels;
  /** Kinds of worker, by name. */
  workers: Record<string, WorkerKind>;
};

const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * A later value applied over an earlier one, as a JSON Merge Patch (RFC 7386):
 * plain objects merge field by field, `null` removes a field, and anything
 * else (strings, numbers, arrays, functions) replaces it.
 */
export function patch(target: unknown, value: unknown): unknown {
  if (!plain(value)) return value;
  const out: Record<string, unknown> = plain(target) ? { ...target } : {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null) delete out[key];
    else out[key] = patch(out[key], v);
  }
  return out;
}

/**
 * Plugins merge in order. Collections, Actions and Processors are unique: two
 * of one name are a mistake. Everything else is configuration a later plugin
 * may change: resources and schedules patch entry by entry (see `patch`), and
 * a later View or adapter replaces an earlier one of its name; `null` removes
 * any of them. What each plugin `requires` must be there, except in a
 * client's (`elsewhere`), which loads front ends whose plugins live with the
 * owner. Each plugin's startup check runs later (`checked`).
 */
export function merge(list: Plugins, options: { elsewhere?: boolean } = {}): Registry {
  const plugins = (list as unknown[]).flat(Infinity) as Plugin[];
  const registry: Registry = {
    collections: {},
    actions: {},
    events: {},
    processors: {},
    views: {},
    resources: {},
    adapters: {},
    schedules: {},
    checks: [],
    guards: [],
    workers: {},
  };
  const into = <T>(
    target: Record<string, T>,
    source: Record<string, T> | undefined,
    what: string,
  ) => {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (name in target) throw invalid(`Duplicate ${what} "${name}"`);
      target[name] = value;
    }
  };
  const replace = (target: Record<string, unknown>, source: Record<string, unknown>) => {
    for (const [name, value] of Object.entries(source)) {
      if (value === null) delete target[name];
      else target[name] = value;
    }
  };
  for (const plugin of plugins) {
    for (const [name, def] of Object.entries(plugin.collections ?? {})) {
      if ("schema" in def) {
        into(registry.collections, { [name]: def }, "collection");
        continue;
      }
      // A patch: indexes on a collection an earlier plugin declared (its definition stays as it is).
      const declared = registry.collections[name];
      if (!declared) {
        throw invalid(`${plugin.name} adds indexes to "${name}", which no earlier plugin declares`);
      }
      registry.collections[name] = {
        ...declared,
        indexes: [...declared.indexes ?? [], ...def.indexes],
      };
    }
    into(registry.actions, plugin.actions, "action");
    into(registry.events, plugin.events, "event");
    into(registry.processors, plugin.processors, "processor");
    for (const [kind, renderers] of Object.entries(plugin.views ?? {})) {
      replace(registry.views[kind] ??= {}, renderers);
    }
    for (const [kind, entries] of Object.entries(plugin.resources ?? {})) {
      registry.resources[kind] = patch(registry.resources[kind], entries) as Record<
        string,
        unknown
      >;
    }
    for (const [port, entries] of Object.entries(plugin.adapters ?? {})) {
      replace(registry.adapters[port] ??= {}, entries);
    }
    into(registry.workers, plugin.workers, "worker kind");
    if (plugin.guard) registry.guards.push(plugin.guard);
    if (plugin.labels) registry.labels = plugin.labels;
    for (const [name, entry] of Object.entries(plugin.schedules ?? {})) {
      if (entry === null) delete registry.schedules[name];
      else registry.schedules[name] = patch(registry.schedules[name], entry) as ScheduleDef;
    }
  }
  // The runtime's own events aren't anyone's to declare.
  for (const type of Object.keys(registry.events)) {
    const [owner, change] = [
      type.slice(0, type.lastIndexOf(".")),
      type.slice(type.lastIndexOf(".") + 1),
    ];
    if (
      /^(action|processor)\./.test(type) ||
      (owner in registry.collections && ["created", "updated", "deleted"].includes(change))
    ) {
      throw invalid(`Event "${type}" is the runtime's own: it can't be declared`);
    }
  }
  // A worker kind's Actions are there (where the owner runs them).
  for (const [kind, def] of options.elsewhere ? [] : Object.entries(registry.workers)) {
    if (kind.includes(":")) throw invalid(`Worker kind "${kind}" can't have ":" in its name`);
    for (const action of [def.admit, def.ready, def.gone]) {
      if (action && !registry.actions[action]) {
        throw invalid(`Worker kind "${kind}" names "${action}", which no plugin declares`);
      }
    }
  }
  // What each plugin builds on is there.
  const names = new Set(plugins.map((p) => p.name));
  for (const plugin of options.elsewhere ? [] : plugins) {
    const missing = (plugin.requires ?? []).filter((name) => !names.has(name));
    if (missing.length) throw invalid(`${plugin.name} needs ${missing.join(", ")}: add it too`);
  }
  registry.checks = plugins.flatMap((p) => p.check ? [{ name: p.name, check: p.check }] : []);
  return registry;
}

/**
 * Runs every plugin's startup check on the merged configuration, in order;
 * the first that throws stops the runtime from starting.
 */
export async function checked(registry: Registry, call: Merged["call"]): Promise<void> {
  const merged: Merged = { resources: registry.resources, adapters: registry.adapters, call };
  for (const { name, check } of registry.checks) {
    try {
      await check(merged);
    } catch (error) {
      throw invalid(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Each unrecorded Action's input check, made once. */
const inputChecks = new WeakMap<ActionDef, (value: unknown) => void>();

/**
 * Calls an unrecorded Action from a read (a query, a View, a startup
 * check): inline, with a read-only context made from what the read reaches.
 * It reads and records; anything it would write fails.
 */
export async function readCall<R>(
  registry: Registry,
  reads: Omit<ReadContext, "call"> & { signal?: AbortSignal },
  call: ReadContext["call"],
  name: string,
  input: unknown = {},
): Promise<R> {
  const def = registry.actions[name];
  if (!def) throw invalid(`Unknown action "${name}"`);
  if (def.record !== false) {
    throw invalid(`"${name}" is recorded: a read calls only unrecorded Actions`);
  }
  const normalized = json(input);
  if (def.input) {
    let check = inputChecks.get(def);
    if (!check) inputChecks.set(def, check = compile(def.input, `action "${name}" input`));
    check(normalized);
  }
  const refuse = () => {
    throw invalid(`"${name}" was called from a read: it can't write`);
  };
  const ctx = {
    ...reads,
    call,
    signal: reads.signal ?? new AbortController().signal,
    retry: false,
    emit: refuse,
    transaction: refuse,
    schedule: refuse,
    unschedule: refuse,
    cancel: refuse,
    stream: refuse,
    graph: { ...reads.graph, link: refuse, unlink: refuse },
  } as unknown as Context;
  return await def.run({ ...ctx, as: () => ctx, branch: () => ctx } as Context, normalized) as R;
}

/**
 * Checks an event a plugin emits: declared, and its data as declared. Each
 * schema is compiled the first time its type is emitted.
 */
export function events(
  registry: Pick<Registry, "events">,
): (type: string, data: unknown) => EventDef {
  const checks = new Map<string, (value: unknown) => void>();
  return (type, data) => {
    const def = registry.events[type];
    if (!def) throw invalid(`Undeclared event "${type}": a plugin declares it in its events`);
    let check = checks.get(type);
    if (!check) checks.set(type, check = compile(def.schema, `event "${type}"`));
    check(data);
    return def;
  };
}
