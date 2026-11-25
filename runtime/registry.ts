/**
 * Merges plugins into one registry of primitives. The owner and every
 * executor build the same registry from the same plugins.
 */
import { missingCollectionSchema } from "./collection.ts";
import { Validator } from "@cfworker/json-schema";
import type {
  ActionDef,
  Adapters,
  CollectionDef,
  Context,
  Description,
  EventDef,
  Guard,
  Labels,
  Merged,
  Plugin,
  Plugins,
  ProcessorDef,
  ReadContext,
  Resources,
  Route,
  Views,
  Who,
  WorkerKind,
} from "./define.ts";
import type { ScheduleDef } from "./schedules.ts";
import type { Actor } from "./store.ts";
import { allows, grant } from "./actor.ts";

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

/**
 * A copy of `value` without the private fields at these (dotted) paths: a
 * collection's (see `CollectionDef.private`) or an Action's (`ActionDef.private`).
 */
export function unprivate<T>(value: T, fields: string[]): T {
  if (!fields.length || !value || typeof value !== "object") return value;
  const copy = structuredClone(value) as Record<string, unknown>;
  for (const path of fields) {
    const keys = path.split(".");
    let at: Record<string, unknown> | undefined = copy;
    for (const key of keys.slice(0, -1)) at = at?.[key] as Record<string, unknown> | undefined;
    if (at && typeof at === "object") delete at[keys.at(-1)!];
  }
  return copy as T;
}

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
      const first = deepest(result.errors);
      throw schemaFailure(
        label,
        first?.error ?? "invalid",
        first?.instanceLocation ?? "#",
        first?.keyword,
      );
    }
  };
}

/** Of a validation's errors, the one about the innermost value: the field itself, not its parent. */
export const deepest = <E extends { instanceLocation: string }>(errors: E[]): E | undefined =>
  errors.reduce<E | undefined>(
    (best, e) =>
      !best || e.instanceLocation.split("/").length >= best.instanceLocation.split("/").length
        ? e
        : best,
    undefined,
  );

/**
 * A document that doesn't fit its schema: `invalid`, saying where (`#/price`),
 * with the field it's about in `detail.field` (a dot path; for a required
 * field that's missing, that field), for a form to show it there. Marked
 * `schema`, so writes from outside can say it to their caller (see owner.ts).
 */
export function schemaFailure(
  label: string,
  error: string,
  location: string,
  rule?: string,
): Error & { code: string; detail?: { field: string }; schema: true } {
  const path = location.replace(/^#\/?/, "").split("/").filter(Boolean).map(unescapePointer);
  const missing = rule === "required" ? /property "([^"]+)"/.exec(error)?.[1] : undefined;
  const field = [...path, ...(missing ? [missing] : [])].join(".");
  return Object.assign(invalid(`${label}: ${error} (${location})`), {
    ...(field ? { detail: { field } } : {}),
    schema: true as const,
  });
}

const unescapePointer = (part: string) => part.replaceAll("~1", "/").replaceAll("~0", "~");

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
  /** Which plugin each guard is (by position in `guards`). */
  guardPlugins: string[];
  /**
   * Each collection's plugin, and whether it says who reaches it (its own
   * guard, or its own `shared` entry): a rule of another's alone opening it
   * is warned of (owner.ts).
   */
  ruledBy: Record<string, { plugin: string; own: boolean }>;
  /** What looks wrong at startup, though the app runs (see `warningsOf`): logged once. */
  warnings: string[];
  /** What reads reveal to writes: the last plugin's. */
  labels?: Labels;
  /** Kinds of worker, by name. */
  workers: Record<string, WorkerKind>;
  /** Plugins' routes, by pattern, each with the plugin that declares it (see runtime/routes.ts). */
  routes: Record<string, { route: Route; plugin: string }>;
  /** Plugins' `who`, in plugin order: the first that answers says who a request is. */
  whos: { plugin: string; who: Who }[];
  /** What each plugin builds on, by name (its `requires`). */
  requires: Record<string, string[]>;
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

/** Whether a schema says what its documents hold: fields, or the shapes they may take. */
export const says = (schema: unknown): boolean =>
  plain(schema) &&
  (plain(schema.properties) && Object.keys(schema.properties).length > 0 ||
    ["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(schema[key])) ||
    plain(schema.additionalProperties) || plain(schema.patternProperties));

/**
 * What looks wrong, though the app runs: a collection whose schema names no
 * fields (its documents may hold anything, and writes check nothing); one
 * that another plugin's `shared` rule alone opens to outsiders (its own
 * plugin says nothing of who may reach it). A guard can't be read without
 * running it, so only `shared` entries are looked at.
 */
function warningsOf(
  plugins: Plugin[],
  registry: Registry,
  declaredBy: Map<string, Plugin>,
): string[] {
  const out: string[] = [];
  for (const [name, def] of Object.entries(registry.collections)) {
    if (!says(def.schema)) {
      out.push(
        `Collection "${name}" (${declaredBy.get(name)?.name}) has a schema that names no fields: ` +
          "its documents may hold anything, and writes check nothing. Name its fields.",
      );
    }
  }
  const sharedOf = (p: Plugin) =>
    plain(p.resources?.shared) ? Object.keys(p.resources.shared as object) : [];
  for (const other of plugins) {
    for (const name of sharedOf(other)) {
      const own = declaredBy.get(name);
      if (!own || own === other || own.guard || sharedOf(own).includes(name)) continue;
      out.push(
        `Collection "${name}" (${own.name}) is opened to outsiders by ${other.name}'s ` +
          `"shared" rule alone: say who reaches it in ${own.name}.`,
      );
    }
  }
  return out;
}

/** Every named query, as `collection.query`. */
export const queriesOf = (registry: Pick<Registry, "collections">): string[] =>
  Object.entries(registry.collections).flatMap(([name, def]) =>
    Object.keys(def.queries ?? {}).map((query) => `${name}.${query}`)
  );

/** An unknown name refused, with the closest known one when there's one near it. */
export function unknown(kind: string, name: string, known: Iterable<string>): Error {
  const near = closest(name, known);
  return invalid(`Unknown ${kind} "${name}"${near ? ` (did you mean "${near}"?)` : ""}`);
}

/** The known name nearest `name`, within two edits (a quarter of a long name's letters). */
export function closest(name: string, known: Iterable<string>): string | undefined {
  let best: string | undefined;
  let score = Infinity;
  for (const candidate of known) {
    const d = distance(name, candidate);
    if (d < score) [best, score] = [candidate, d];
  }
  return best !== undefined && score <= Math.max(2, Math.floor(name.length / 4)) ? best : undefined;
}

/** Levenshtein distance. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const was = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = was;
    }
  }
  return row[b.length];
}

/**
 * Plugins merge in order. Collections, Actions and Processors are unique: two
 * of one name are a mistake. Everything else is configuration a later plugin
 * may change: resources and schedules patch entry by entry (see `patch`), and
 * a later View, adapter or route replaces an earlier one of its name; `null`
 * removes any of them. Each plugin's `who` is kept, in order. What each plugin `requires` must be there, except in a
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
    guardPlugins: [],
    ruledBy: {},
    warnings: [],
    workers: {},
    routes: {},
    whos: [],
    requires: {},
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
  // Which plugin declared each collection, for the warnings below.
  const declaredBy = new Map<string, Plugin>();
  for (const plugin of plugins) {
    for (const [name, def] of Object.entries(plugin.collections ?? {})) {
      if ("schema" in def) {
        if (def.schema === missingCollectionSchema) {
          throw invalid(
            `Collection "${name}" has no schema: run \`copilotz gen\` or write \`schema\`.`,
          );
        }
        const allow = plugin.defaults?.allow;
        const queries = allow && def.queries && Object.fromEntries(
          Object.entries(def.queries).map(([key, q]) => [
            key,
            typeof q === "function" ? { allow, run: q } : { ...q, allow: q.allow ?? allow },
          ]),
        );
        into(registry.collections, { [name]: queries ? { ...def, queries } : def }, "collection");
        declaredBy.set(name, plugin);
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
    for (const [name, def] of Object.entries(plugin.actions ?? {})) {
      if (def.as !== undefined && (typeof def.as !== "string" || !def.as.trim())) {
        throw invalid(`Action "${name}" needs a named grant in as`);
      }
      const allow = def.allow ?? plugin.defaults?.allow;
      into(registry.actions, { [name]: allow === def.allow ? def : { ...def, allow } }, "action");
    }
    into(registry.events, plugin.events, "event");
    into(registry.processors, plugin.processors, "processor");
    replace(registry.views, plugin.views ?? {});
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
    if (plugin.guard) {
      registry.guards.push(plugin.guard);
      registry.guardPlugins.push(plugin.name);
    }
    if (plugin.who) registry.whos.push({ plugin: plugin.name, who: plugin.who });
    for (const [key, route] of Object.entries(plugin.routes ?? {})) {
      if (route === null) delete registry.routes[key];
      else registry.routes[key] = { route, plugin: plugin.name };
    }
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
  if (!options.elsewhere) registry.warnings = warningsOf(plugins, registry, declaredBy);
  for (const [name, plugin] of declaredBy) {
    const shared = plugin.resources?.shared;
    registry.ruledBy[name] = {
      plugin: plugin.name,
      own: !!plugin.guard || (plain(shared) && Object.hasOwn(shared, name)),
    };
  }
  registry.requires = Object.fromEntries(plugins.map((p) => [p.name, p.requires ?? []]));
  return registry;
}

/**
 * Runs every plugin's startup check on the merged configuration, in order;
 * the first that throws stops the runtime from starting.
 */
export async function checked(registry: Registry, call: Merged["call"]): Promise<void> {
  const merged: Merged = {
    resources: registry.resources,
    adapters: registry.adapters,
    actions: registry.actions,
    views: Object.keys(registry.views),
    call,
  };
  for (const { name, check } of registry.checks) {
    try {
      await check(merged);
    } catch (error) {
      throw invalid(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Each registry's description, made once. */
const descriptions = new WeakMap<Registry, Description>();

/** What a registry's plugins declare (see `Description`), made once and kept. */
export function described(registry: Registry): Description {
  let made = descriptions.get(registry);
  if (made) return made;
  made = {
    collections: Object.fromEntries(
      Object.entries(registry.collections).map(([name, def]) => [name, { schema: def.schema }]),
    ),
    actions: Object.fromEntries(
      Object.entries(registry.actions).map(([name, def]) => [name, {
        ...(def.description ? { description: def.description } : {}),
        ...(def.input ? { input: def.input } : {}),
        ...(def.record === false ? { record: false as const } : {}),
      }]),
    ),
    views: Object.keys(registry.views),
    resources: registry.resources,
  };
  descriptions.set(registry, made);
  return made;
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
  actingAs?: (other?: Actor) => ReadContext,
): Promise<R> {
  const def = registry.actions[name];
  if (!def) throw unknown("action", name, Object.keys(registry.actions));
  if (def.record !== false) {
    throw invalid(`"${name}" is recorded: a read calls only unrecorded Actions`);
  }
  const normalized = json(input);
  if (def.input) {
    let check = inputChecks.get(def);
    if (!check) inputChecks.set(def, check = compile(def.input, `action "${name}" input`));
    check(normalized);
  }
  // A read for someone calls what lets them, as any code acting for them does.
  const { actor } = reads;
  if (
    def.allow && actor && actor.kind !== "system" &&
    !await allows(def.allow, actor, normalized, (who) => {
      if (who === actor) return reads;
      if (!actingAs) throw invalid("This read can't check another actor's permission");
      return actingAs(who);
    })
  ) {
    throw Object.assign(new Error(`${actor.kind} ${actor.id} may not call "${name}".`), {
      code: "forbidden",
    });
  }
  const refuse = () => {
    throw invalid(`"${name}" was called from a read: it can't write`);
  };
  /** A read-only Context over what a reader reaches: reads and records; anything else fails. */
  const contextOf = (
    over: Omit<ReadContext, "call"> & { signal?: AbortSignal },
    calls: ReadContext["call"],
  ): Context => {
    const ctx = {
      ...over,
      call: calls,
      describe: () => described(registry),
      signal: reads.signal ?? new AbortController().signal,
      retry: false,
      emit: refuse,
      transaction: refuse,
      schedule: refuse,
      unschedule: refuse,
      cancel: refuse,
      disconnect: refuse,
      stream: refuse,
      graph: { ...over.graph, link: refuse, unlink: refuse },
    } as unknown as Context;
    // Acting as someone else (the system, a grant) reads as them, as from an Action; where
    // the read can't (a startup check), it fails rather than read less than asked.
    const as = (other?: Actor): Context => {
      // Already who it would act as: the same actor, or the system for the system.
      const self = over.actor;
      if (
        other
          ? self && other.kind === self.kind && other.id === self.id
          : !self || self.kind === "system" && self.id === "system" && !self.via
      ) return whole;
      if (!actingAs) {
        throw invalid(
          `"${name}" was called from a read: it can't act as ` +
            `${other ? `${other.kind} ${other.id}` : "the system"} there. Call it from an Action`,
        );
      }
      const them = actingAs(other);
      return contextOf(them, them.call);
    };
    const whole = { ...ctx, as, branch: () => whole } as Context;
    return whole;
  };
  if (def.transaction) throw invalid(`"${name}" needs a transaction: a read can't start one`);
  const ctx = contextOf(reads, call);
  return await def.run(def.as ? ctx.as(grant(def.as)) : ctx, normalized) as R;
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
