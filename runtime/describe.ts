/**
 * A plugin's declaration: everything it declares, as data a person can read
 * before adding it, the way a browser extension lists its permissions. A
 * plugin is already data (`definePlugin` returns it), so there's no manifest
 * to write: `describe(plugin)` reads what's there and says it plainly.
 *
 * - **Who it is:** its name, the plugins it `requires`, and the package and
 *   runtime it comes with, when the caller knows them.
 * - **What it keeps** (`keeps`): its collections (schema, whether durable,
 *   on the record or a ledger, vectors, private fields), their named queries
 *   and who outside may run them, indexes it adds to others' collections,
 *   and which collections the access rules cover (its `shared` resource).
 * - **Who may call what** (`actions`): each Action, with who outside may
 *   call it. `allow` is a function, so it's asked about made-up callers (a
 *   person, an agent working for one, a contact, someone anonymous, a key, a
 *   routine, the maintenance key), each working in a space, with a minimal
 *   input from the Action's schema, as the runtime asks it (`allows`). `run`
 *   is never called. An `allow` that reads the input to decide, or throws,
 *   lets that caller in only "some" of the time: it depends on input.
 * - **The rest:** the tools it gives agents, its Views by where they show
 *   (from their names), routes, events it declares and the changes it
 *   records, what wakes its Processors, schedules, `who`, `guard` and
 *   `labels`, resources it provides, adapters, and kinds of worker.
 * - **What it needs** (`needs`): the settings an operator gives it, from
 *   its contract's types (the CLI finds those), and what its startup check
 *   refuses when nothing is set.
 *
 * Everything is JSON, sorted by name, so the same plugin always describes
 * the same. `listing(declaration)` says whether a hub can list it. The
 * field names are the hub's (`keeps`, `needs`, `listens`, `powers`).
 */
import { allows } from "./actor.ts";
import type {
  ActionDef,
  CollectionDef,
  CollectionPatch,
  EventDef,
  JSONSchema,
  Merged,
  Plugin,
  ProcessorDef,
  QueryDef,
  Route,
  ViewDef,
} from "./define.ts";
import { contacts, inPerson, people, peopleOrContacts } from "./errors.ts";
import { merge, patch } from "./registry.ts";
import type { ScheduleDef, SchedulePatch } from "./schedules.ts";
import type { Actor, Filter } from "./store.ts";

/** The declaration format's version: a change that breaks readers bumps it. */
export const DECLARATION_FORMAT = 1;

/** The made-up callers `allow` is asked about. */
export type CallerKind =
  | "person"
  | "agent"
  | "contact"
  | "anonymous"
  | "key"
  | "routine"
  | "maintenance";

/**
 * Whether `allow` lets a caller in: `some` when it depends on input (it reads
 * the input to decide, or throws without the right one).
 */
export type Admission = "yes" | "no" | "some";

/** Who outside may call (or run, or emit) it, by kind of caller. */
export type Callers = Record<CallerKind, Admission>;

/** What a `some` means, in words. */
export const DEPENDS = "depends on input";

/** Where the made-up callers' work is (`in`): a space, as a way in says it. */
const HERE = "probe-space";

/**
 * The callers, as `allow` is asked about them, each with where its work is
 * (`in`): a person; an agent working for one (`for`); a contact; someone
 * signed out; a key, its person's with a scope of its own; a routine, a
 * person's work done for them (`origin`); and the maintenance key. A key and
 * a routine are what `inPerson` keeps out, and `people` lets in.
 */
export const PROBES: Record<CallerKind, Actor> = {
  person: { kind: "person", id: "probe-person", in: HERE },
  agent: {
    kind: "agent",
    id: "probe-agent",
    for: { kind: "person", id: "probe-person", in: HERE },
    in: HERE,
  },
  contact: { kind: "contact", id: "probe-contact", in: HERE },
  anonymous: { kind: "anonymous", id: "" },
  key: { kind: "person", id: "probe-person", key: "probe-key", scope: {}, in: HERE },
  routine: {
    kind: "person",
    id: "probe-person",
    origin: { kind: "routine", id: "probe-routine" },
    in: HERE,
  },
  maintenance: { kind: "maintenance", id: "maintenance" },
};

/** The runtime's helpers an `allow` may be, by name (`anyone`: it lets every caller in). */
export type Helper =
  | "people"
  | "inPerson"
  | "contacts"
  | "peopleOrContacts"
  | "isMaintenance"
  | "anyone";

/** Who outside reaches a named query (`internal`: plugin code alone, a bare function). */
export type QueryDeclaration = {
  name: string;
  internal?: true;
  callers?: Callers;
  helper?: Helper;
  note?: string;
};

export type CollectionDeclaration = {
  name: string;
  /** Its schema's `description`, when it has one. */
  summary: string;
  /** `documents` change; `records` are appended and never change (a ledger); `live` is memory only. */
  kind: "documents" | "records" | "live";
  /** Its schema's top-level properties. */
  fields: string[];
  schema: JSONSchema;
  /** False: kept in the owner's memory, gone on restart, never on the record. */
  durable: boolean;
  /** Its writes are on the record, as `<name>.created/updated/deleted` events. */
  recorded: boolean;
  /** Fields only trusted code reads (tokens, keys). */
  private: string[];
  /** Under the access rules: it's one of its `shared` resource's entries. */
  shared: boolean;
  /** Fields holding vectors (embeddings). */
  vectors: string[];
  indexes: string[][];
  queries: QueryDeclaration[];
};

/** A collection the access rules cover: a `shared` resource entry, with its options. */
export type SharedDeclaration = { collection: string; options: Record<string, unknown> };

export type ActionDeclaration = {
  name: string;
  /** Its description, or nothing. */
  summary: string;
  input?: JSONSchema;
  /** Its calls are on the record (`action.started/completed/failed`). */
  recorded: boolean;
  /** Fields its calls are recorded without. */
  private: string[];
  /** No `allow`: plugin code, schedules and the system call it, nobody outside. */
  internal?: true;
  callers?: Callers;
  helper?: Helper;
  /** Why a caller is `some`. */
  note?: string;
  /** The agent tool that calls it (its code names it). */
  tool?: string;
};

/** A tool it gives agents (its `tools` resource). */
export type ToolDeclaration = { name: string; summary: string; title?: string; input?: JSONSchema };

/** Where a View shows, from its name: the web, the terminal, the model's prompt, or elsewhere. */
export type Place = "web" | "terminal" | "prompt" | "other";

export type ViewDeclaration = {
  name: string;
  place: Place;
  /** It removes another plugin's View of this name (`null`). */
  removes?: true;
};

export type RouteDeclaration = {
  /** Its `URLPattern`: a pathname, or a whole URL with a host. */
  path: string;
  /** The methods its code names, as one (`GET, POST`); `ANY` when it names none. */
  method: string;
  methods: string[];
  /** It takes whole hosts, whatever the path (`https://*-preview.example.com/*`). */
  host: boolean;
  /** Its path starts with the plugin's name (`/mcp/*` for `mcp`). */
  underName: boolean;
  /** It removes another plugin's route (`null`). */
  removes?: true;
};

/** Something the operator gives it: a setting in a resource, or a secret. */
export type NeedDeclaration = {
  kind: "setting" | "secret";
  /** Where it goes in the app's resources: `google.clientId`, `whatsapp.<name>.token`. */
  path: string;
  summary: string;
  required: boolean;
  type?: string;
};

/** An event it declares, beyond its collections' changes and its Actions' lifecycle. */
export type EventDeclaration = {
  type: string;
  summary: string;
  schema: JSONSchema;
  /** Who may emit it from outside; none: the system alone. A key never may. */
  internal?: true;
  callers?: Callers;
};

export type ProcessorDeclaration = {
  name: string;
  /** The event types that wake it ("*": every one). */
  on: string[];
  where?: Filter;
  /** Whether events run in order by a key of its own. */
  keyed: boolean;
};

export type ScheduleDeclaration = {
  name: string;
  /** When, in words: `every 1h`, `cron 20 0 * * * (UTC)`. */
  when: string;
  /** What the Action it calls says it does. */
  summary: string;
  call?: string;
  cron?: string;
  timezone?: string;
  every?: string | number;
  /** A change to a schedule another plugin declared. */
  patch?: true;
  removes?: true;
};

/** What it does beyond its own data, shown the way a browser extension's broad permissions are. */
export type Power = "who" | "guard" | "labels" | "workers";

/** A resource entry, in brief: what it says about itself when it's an object. */
export type EntryDeclaration = {
  description?: string;
  title?: string;
  view?: string;
  action?: string;
  /** `null`: it removes another plugin's entry. */
  removes?: true;
};

/**
 * A resource kind it reads, and how that was found: `declared` (its `reads`,
 * see `Readable`), `check` (its startup check read it), `source` (its code
 * reads it, found by a scan of its files: the CLI's).
 */
export type ResourceRead = { kind: string; found: ("declared" | "check" | "source")[] };

/** A field of a setting, from the TypeScript type its contract exports (found by the CLI). */
export type SettingField = {
  name: string;
  type: string;
  optional: boolean;
  doc?: string;
  /** A credential: a key, token, secret or password. */
  secret: boolean;
};

/** A resource kind the operator sets, with its type's fields. */
export type SettingDeclaration = {
  kind: string;
  /** The TypeScript type, by name (`GoogleSettings`). */
  type?: string;
  /** Whether that type is exported by the plugin's module or contract. */
  inContract?: boolean;
  /** The fields, of each entry when the kind is a map (`whatsapp.<name>.token`). */
  fields: SettingField[];
  each?: boolean;
  doc?: string;
};

export type CheckDeclaration = {
  /** The resource kinds its startup check read. */
  reads: string[];
  /** Unrecorded Actions it asked (`models.check`). */
  asks: string[];
  /** What it says with only the plugin's own resources set: what an operator must add. */
  refuses?: string;
};

export type WorkerDeclaration = {
  kind: string;
  admit: string;
  ready?: string;
  gone?: string;
  workloads: string[];
};

export type Listing = {
  /** Whether a hub may list it: no problems. */
  listable: boolean;
  /** What stops it being listed, in words. */
  problems: string[];
  /** What a person should know before adding it (Actions open to anyone…). */
  warnings: string[];
};

export type Declaration = {
  format: typeof DECLARATION_FORMAT;
  name: string;
  /** What it is, in a sentence (its doc's first, found by the CLI). */
  summary?: string;
  requires: string[];
  /** The package it comes in, when known (`copilotz`, `@copilotz/work`). */
  package?: { name: string; version?: string };
  /** The `copilotz` versions it runs on, when known (`^1.0.0`). */
  runtime?: string;
  /** Where it ships: with `copilotz` (standard), in a package of its own… */
  layer?: string;
  keeps: CollectionDeclaration[];
  /** Indexes it adds to collections other plugins declare. */
  indexes: { collection: string; indexes: string[][] }[];
  /** The collections it puts under the access rules (its `shared` resource). */
  shared: SharedDeclaration[];
  actions: ActionDeclaration[];
  tools: ToolDeclaration[];
  views: ViewDeclaration[];
  routes: RouteDeclaration[];
  needs: NeedDeclaration[];
  emits: EventDeclaration[];
  /** Its collections' changes, on the record. */
  changes: string[];
  /** Event types its Processors react to. */
  listens: string[];
  processors: ProcessorDeclaration[];
  schedules: ScheduleDeclaration[];
  powers: Power[];
  resources: {
    /** What it provides, by kind and entry name. */
    provides: Record<string, Record<string, EntryDeclaration>>;
    reads: ResourceRead[];
  };
  adapters: Record<string, string[]>;
  workers: WorkerDeclaration[];
  check: CheckDeclaration | null;
  /** Its settings, from its contract's types (found by the CLI). */
  settings: SettingDeclaration[];
  listing: Listing;
};

/**
 * A plugin that says which resource kinds it reads (a proposal, not yet in
 * `Plugin`): its settings and the kinds other plugins fill for it (`tools`,
 * `shared`). Without it, a plugin's reads are found only where its startup
 * check or its code shows them.
 */
export type Readable = Plugin & { reads?: string[] };

export type DescribeOptions = {
  summary?: string;
  package?: { name: string; version?: string };
  runtime?: string;
  layer?: string;
  /** Resource kinds its code reads (a scan of its files): added as `source`. */
  reads?: string[];
  settings?: SettingDeclaration[];
  /** How long its startup check may take, in ms (1000). */
  checkTimeout?: number;
};

// ---------------------------------------------------------------------------
// Helpers

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
const by = <T>(key: (item: T) => string) => (a: T, b: T) =>
  key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** A JSON copy: functions and undefined fields go. */
const json = <T>(value: T): T =>
  value === undefined
    ? value
    : JSON.parse(JSON.stringify(value, (_k, v) => typeof v === "function" ? undefined : v));

/**
 * A small input that a JSON Schema accepts: its required fields, each the
 * simplest value of its type ("x" for a string, which most checks take).
 */
export function minimalOf(schema: unknown, depth = 0): unknown {
  if (!plain(schema) || depth > 5) return undefined;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ("default" in schema) return schema.default;
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const options = schema[key];
    if (Array.isArray(options) && options.length && !schema.type) {
      return options.map((option) => minimalOf(option, depth + 1)).find((v) => v !== undefined);
    }
  }
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const type = types.find((t) => t !== "null") ?? types[0] ??
    (schema.properties ? "object" : undefined);
  switch (type) {
    case "object": {
      const properties = plain(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? schema.required as string[] : [];
      return Object.fromEntries(
        required.map((name) => [name, minimalOf(properties[name], depth + 1) ?? "x"]),
      );
    }
    case "array": {
      const min = typeof schema.minItems === "number" ? schema.minItems : 0;
      const item = minimalOf(schema.items, depth + 1) ?? "x";
      return Array.from({ length: min }, () => item);
    }
    case "string":
      return "x".repeat(Math.max(1, typeof schema.minLength === "number" ? schema.minLength : 1));
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return undefined;
  }
}

/** The value, watched: whether anything read it (a field, its keys). */
function watched(value: unknown): { value: unknown; read: () => boolean } {
  let read = false;
  if (value === null || typeof value !== "object") return { value, read: () => false };
  const proxy = new Proxy(value as object, {
    get(target, key, receiver) {
      if (typeof key === "string") read = true;
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      read = true;
      return Reflect.has(target, key);
    },
    ownKeys(target) {
      read = true;
      return Reflect.ownKeys(target);
    },
  });
  return { value: proxy, read: () => read };
}

type Allow = (actor: Actor, input: unknown) => boolean;

/** Whether `allow` lets `actor` in, as the runtime asks it: an agent, and whom it works for. */
const admits = (allow: Allow, actor: Actor, input: unknown): boolean => allows(allow, actor, input);

/** Asks `allow` about each made-up caller, with `input`: whom it lets in. */
// deno-lint-ignore no-explicit-any
export function probe(allow: (actor: Actor, input: any) => unknown, input: unknown = {}): Callers {
  const callers = {} as Callers;
  for (const [kind, actor] of Object.entries(PROBES) as [CallerKind, Actor][]) {
    const given = watched(structuredClone(input));
    try {
      const yes = admits((a, i) => !!allow(a, i), structuredClone(actor), given.value);
      callers[kind] = given.read() ? "some" : yes ? "yes" : "no";
    } catch {
      callers[kind] = "some";
    }
  }
  return callers;
}

const isMaintenance = (actor: Actor): boolean => actor.kind === "maintenance";

const HELPERS: [Helper, Allow][] = [
  ["people", people],
  ["inPerson", inPerson],
  ["contacts", contacts],
  ["peopleOrContacts", peopleOrContacts],
  ["isMaintenance", isMaintenance],
];

/**
 * Which runtime helper an `allow` is: the helper itself, or a function of its
 * name that lets in exactly whom it does (the maintenance plugin's
 * `isMaintenance`, a helper from another copy of the runtime). A plugin's
 * own function of the same name that lets in others isn't one.
 */
export function helperOf(allow: unknown): Helper | undefined {
  if (typeof allow !== "function") return undefined;
  const same = HELPERS.find(([, helper]) => helper === allow);
  if (same) return same[0];
  const named = HELPERS.find(([name]) => name === allow.name);
  if (!named) return undefined;
  const callers = probe(allow as Allow);
  return JSON.stringify(callers) === JSON.stringify(probe(named[1])) ? named[0] : undefined;
}

/** Who outside an `allow` lets in: nobody (internal) without one; `anyone` when it says yes to all. */
const accessOf = (
  // deno-lint-ignore no-explicit-any
  allow: ((actor: Actor, input: any) => unknown) | undefined,
  input: unknown,
): { internal?: true; callers?: Callers; helper?: Helper; note?: string } => {
  if (typeof allow !== "function") return { internal: true };
  const callers = probe(allow, input);
  const values = Object.values(callers);
  const helper = helperOf(allow) ?? (values.every((v) => v === "yes") ? "anyone" : undefined);
  return {
    callers,
    ...(helper ? { helper } : {}),
    ...(values.includes("some") ? { note: DEPENDS } : {}),
  };
};

/** Where a View shows, from its name, else from the shell its plugin builds on. */
export function placeOf(name: string, shell?: "web" | "terminal"): Place {
  if (/^web[.:]/.test(name)) return "web";
  if (/^terminal[.:]/.test(name)) return "terminal";
  if (/^(llm\.|context:|tool:|mcp:)/.test(name)) return "prompt";
  return shell ?? "other";
}

/** The shell a plugin's Views draw in, when it builds on one (`requires: ["web-shell"]`). */
const shellOf = (plugin: Plugin): "web" | "terminal" | undefined => {
  const names = [plugin.name, ...plugin.requires ?? []];
  if (names.includes("web-shell")) return "web";
  if (names.some((name) => ["terminal-shell", "terminal"].includes(name))) return "terminal";
  return undefined;
};

/** Whether a route's path starts with the plugin's name: `/mcp/*` for `mcp`. */
export function underName(path: string, plugin: string): boolean {
  if (path.includes("://")) return false;
  const first = path.split("/")[1] ?? "";
  return first.toLowerCase() === plugin.toLowerCase();
}

/** The HTTP methods a route's code names (`request.method === "POST"`). */
export function methodsOf(route: Route): string[] {
  const source = String(route);
  return sorted([
    ...source.matchAll(/\bmethod\s*[!=]==?\s*["'`]([A-Z]+)["'`]/g),
    ...source.matchAll(/["'`]([A-Z]+)["'`]\s*[!=]==?\s*[\w.]*\bmethod\b/g),
  ].map(([, method]) => method));
}

/** A resource entry, in brief. */
const entryOf = (value: unknown): EntryDeclaration => {
  if (value === null) return { removes: true };
  if (!plain(value)) return {};
  const out: EntryDeclaration = {};
  for (const key of ["description", "title", "view", "action"] as const) {
    if (typeof value[key] === "string") out[key] = value[key] as string;
  }
  return out;
};

const isSchemaDef = (def: CollectionDef | CollectionPatch): def is CollectionDef => "schema" in def;

const words = (doc: unknown) => typeof doc === "string" ? doc.replace(/\s+/g, " ").trim() : "";

// ---------------------------------------------------------------------------
// Parts

function keepsOf(plugin: Plugin, shared: Set<string>) {
  const keeps: CollectionDeclaration[] = [];
  const indexes: { collection: string; indexes: string[][] }[] = [];
  for (const [name, def] of Object.entries(plugin.collections ?? {})) {
    if (!isSchemaDef(def)) {
      indexes.push({ collection: name, indexes: json(def.indexes ?? []) });
      continue;
    }
    const durable = def.durable !== false;
    const schema = json(def.schema) as Record<string, unknown>;
    keeps.push({
      name,
      summary: words(schema.description),
      kind: !durable ? "live" : def.records === true ? "records" : "documents",
      fields: plain(schema.properties) ? Object.keys(schema.properties) : [],
      schema: schema as JSONSchema,
      durable,
      recorded: durable && def.events !== false && def.records !== true,
      private: sorted(def.private ?? []),
      shared: shared.has(name),
      vectors: sorted(def.vectors ?? []),
      indexes: json(def.indexes ?? []),
      queries: Object.entries(def.queries ?? {}).map(([query, q]: [string, QueryDef]) => ({
        name: query,
        ...(typeof q === "function" ? { internal: true as const } : accessOf(q.allow, {})),
      })).sort(byName),
    });
  }
  return { keeps: keeps.sort(byName), indexes: indexes.sort(by((i) => i.collection)) };
}

/** Its `tools` resource's entries, and which of its Actions each one's code calls. */
function toolsOf(plugin: Plugin, actions: string[]) {
  const tools: ToolDeclaration[] = [];
  const calls = new Map<string, string>();
  for (const [name, tool] of Object.entries(plugin.resources?.tools ?? {})) {
    if (!plain(tool)) continue;
    tools.push({
      name,
      summary: words(tool.description),
      ...(typeof tool.title === "string" ? { title: tool.title } : {}),
      ...(plain(tool.input) ? { input: json(tool.input) as JSONSchema } : {}),
    });
    const source = typeof tool.run === "function" ? String(tool.run) : "";
    for (const [, called] of source.matchAll(/["'`]([\w.:-]+)["'`]/g)) {
      if (actions.includes(called) && !calls.has(called)) calls.set(called, name);
    }
  }
  return { tools: tools.sort(byName), calls };
}

function actionsOf(plugin: Plugin, tools: Map<string, string>): ActionDeclaration[] {
  return Object.entries(plugin.actions ?? {}).map(([name, def]: [string, ActionDef]) => ({
    name,
    summary: words(def.description),
    ...(def.input ? { input: json(def.input) } : {}),
    recorded: def.record !== false,
    private: sorted(def.private ?? []),
    ...accessOf(def.allow, minimalOf(def.input) ?? {}),
    ...(tools.has(name) ? { tool: tools.get(name) } : {}),
  })).sort(byName);
}

function emitsOf(plugin: Plugin): EventDeclaration[] {
  return Object.entries(plugin.events ?? {}).map(([type, def]: [string, EventDef]) => {
    const access = accessOf(def.allow && ((actor: Actor) => def.allow!(actor)), {});
    // A key never emits: the runtime refuses any actor with a scope.
    if (access.callers) access.callers.key = "no";
    const { note: _note, helper: _helper, ...who } = access;
    return { type, summary: words(def.description), schema: json(def.schema), ...who };
  }).sort(by((e) => e.type));
}

const processorsOf = (plugin: Plugin): ProcessorDeclaration[] =>
  Object.entries(plugin.processors ?? {}).map(([name, def]: [string, ProcessorDef]) => ({
    name,
    on: sorted(typeof def.on === "string" ? [def.on] : def.on),
    ...(def.where ? { where: json(def.where) } : {}),
    keyed: typeof def.key === "function",
  })).sort(byName);

const schedulesOf = (plugin: Plugin): ScheduleDeclaration[] =>
  Object.entries(plugin.schedules ?? {}).map(
    ([name, def]: [string, ScheduleDef | SchedulePatch | null]): ScheduleDeclaration => {
      if (def === null) return { name, when: "", summary: "", removes: true };
      const { call, cron, timezone, every } = def as Record<string, unknown>;
      const when = typeof cron === "string"
        ? `cron ${cron} (${typeof timezone === "string" ? timezone : "UTC"})`
        : typeof every === "string" || typeof every === "number"
        ? `every ${every}${typeof every === "number" ? " ms" : ""}`
        : "";
      const action = typeof call === "string" ? plugin.actions?.[call] : undefined;
      return {
        name,
        when,
        summary: words(action?.description),
        ...(typeof call === "string" ? { call } : { patch: true as const }),
        ...(typeof cron === "string" ? { cron } : {}),
        ...(typeof timezone === "string" ? { timezone } : {}),
        ...(typeof every === "string" || typeof every === "number" ? { every } : {}),
      };
    },
  ).sort(byName);

function viewsOf(plugin: Plugin): ViewDeclaration[] {
  const shell = shellOf(plugin);
  return (Object.entries(plugin.views ?? {}) as [string, ViewDef | null][]).map(
    ([name, view]) => ({
      name,
      place: placeOf(name, shell),
      ...(view === null ? { removes: true as const } : {}),
    }),
  ).sort(byName);
}

function providesOf(plugin: Plugin) {
  const provides: Record<string, Record<string, EntryDeclaration>> = {};
  for (const kind of Object.keys(plugin.resources ?? {}).sort()) {
    const entries = plugin.resources![kind] ?? {};
    provides[kind] = Object.fromEntries(
      Object.keys(entries).sort().map((name) => [name, entryOf(entries[name])]),
    );
  }
  return provides;
}

const sharedOf = (plugin: Plugin): SharedDeclaration[] =>
  Object.entries(plugin.resources?.shared ?? {}).filter(([, options]) => options !== null).map((
    [collection, options],
  ) => ({ collection, options: plain(options) ? json(options) : {} })).sort(
    by((s) => s.collection),
  );

const routesOf = (plugin: Plugin): RouteDeclaration[] =>
  Object.entries(plugin.routes ?? {}).map(([path, route]) => {
    const methods = route ? methodsOf(route) : [];
    return {
      path,
      method: methods.length ? methods.join(", ") : "ANY",
      methods,
      host: path.includes("://"),
      underName: underName(path, plugin.name),
      ...(route === null ? { removes: true as const } : {}),
    };
  }).sort(by((r) => r.path));

const adaptersOf = (plugin: Plugin): Record<string, string[]> =>
  Object.fromEntries(
    Object.keys(plugin.adapters ?? {}).sort().map((port) => [
      port,
      Object.keys(plugin.adapters![port] ?? {}).sort(),
    ]),
  );

const workersOf = (plugin: Plugin): WorkerDeclaration[] =>
  Object.entries(plugin.workers ?? {}).map(([kind, def]) => ({
    kind,
    admit: def.admit,
    ...(def.ready ? { ready: def.ready } : {}),
    ...(def.gone ? { gone: def.gone } : {}),
    workloads: [...def.workloads],
  })).sort(by((w) => w.kind));

/** What `call` answers in a probed check: nothing, so the check says what it would have asked. */
const NOT_ASKED = "describe: not asked";

/**
 * Runs the plugin's startup check on its own configuration, watching what it
 * reads and asks: what it refuses is what an operator must add.
 */
async function checkOf(plugin: Plugin, timeout: number): Promise<CheckDeclaration | null> {
  if (typeof plugin.check !== "function") return null;
  const reads = new Set<string>();
  const asks = new Set<string>();
  let resources: Record<string, Record<string, unknown>> = {};
  try {
    resources = merge([plugin], { elsewhere: true }).resources;
  } catch {
    for (const [kind, entries] of Object.entries(plugin.resources ?? {})) {
      resources[kind] = patch(undefined, entries) as Record<string, unknown>;
    }
  }
  const merged = {
    resources: new Proxy(resources, {
      get(target, key, receiver) {
        if (typeof key === "string") reads.add(key);
        return Reflect.get(target, key, receiver);
      },
    }),
    adapters: plugin.adapters ?? {},
    actions: plugin.actions ?? {},
    views: Object.keys(plugin.views ?? {}),
    call: (action: string) => {
      asks.add(action);
      return Promise.reject(new Error(NOT_ASKED));
    },
  } as unknown as Merged;
  let refuses: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => plugin.check!(merged)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(NOT_ASKED)), timeout);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes(NOT_ASKED)) refuses = message;
  } finally {
    clearTimeout(timer);
  }
  return { reads: sorted(reads), asks: sorted(asks), ...(refuses ? { refuses } : {}) };
}

/** What the operator gives it: each setting's fields, and what its check refuses without. */
function needsOf(
  settings: SettingDeclaration[],
  check: CheckDeclaration | null,
): NeedDeclaration[] {
  const needs: NeedDeclaration[] = [];
  for (const s of settings) {
    for (const f of s.fields) {
      needs.push({
        kind: f.secret ? "secret" : "setting",
        path: s.each ? `${s.kind}.<name>.${f.name}` : `${s.kind}.${f.name}`,
        summary: f.doc ?? "",
        required: !f.optional,
        type: f.type,
      });
    }
  }
  // A kind its check reads and refuses without, that no setting's type spoke for.
  if (check?.refuses) {
    const typed = new Set(settings.map((s) => s.kind));
    const kind = check.reads.find((k) => check.refuses!.includes(k) && !typed.has(k));
    if (kind) needs.push({ kind: "setting", path: kind, summary: check.refuses, required: true });
  }
  return needs;
}

// ---------------------------------------------------------------------------
// Listing

/** Whether a schema says anything about its documents' fields. */
const says = (schema: unknown): boolean =>
  plain(schema) &&
  (plain(schema.properties) && Object.keys(schema.properties).length > 0 ||
    ["anyOf", "oneOf", "allOf"].some((key) => Array.isArray(schema[key])) ||
    plain(schema.additionalProperties) || plain(schema.patternProperties));

const opened = (callers?: Callers) => !!callers && callers.anonymous !== "no";

/**
 * Whether a hub may list the plugin, and what a person should know first.
 * Listable: every collection's schema says what its documents hold; every
 * Action declares `allow` or is internal (true by construction: without
 * `allow`, nobody outside calls it); every route lives under the plugin's
 * name (`/<name>/…`); every setting it reads is a type its contract exports.
 */
export function listing(d: Omit<Declaration, "listing">): Listing {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const c of d.keeps) {
    if (!says(c.schema)) problems.push(`Collection "${c.name}" has a schema that names no fields.`);
  }
  for (const r of d.routes) {
    if (r.removes) continue;
    if (r.host) problems.push(`Route "${r.path}" takes whole hosts, not paths under /${d.name}.`);
    else if (!r.underName) problems.push(`Route "${r.path}" isn't under /${d.name}.`);
  }
  for (const s of d.settings) {
    if (s.inContract === false) {
      problems.push(`Setting "${s.kind}" (${s.type ?? "untyped"}) isn't in its contract.`);
    }
  }
  for (const a of d.actions) {
    if (opened(a.callers)) {
      const how = a.callers!.anonymous === "yes" ? "anyone" : `anyone (${DEPENDS})`;
      warnings.push(`Action "${a.name}" is open to ${how}, signed in or not.`);
    }
    if (!a.internal && !a.summary) warnings.push(`Action "${a.name}" has no description.`);
    if (!a.internal && !a.input) warnings.push(`Action "${a.name}" has no input schema.`);
  }
  for (const c of d.keeps) {
    for (const q of c.queries) {
      if (opened(q.callers)) warnings.push(`Query "${c.name}.${q.name}" is open to anyone.`);
    }
  }
  for (const e of d.emits) {
    if (opened(e.callers)) warnings.push(`Event "${e.type}" may be emitted by anyone.`);
  }
  return { listable: problems.length === 0, problems, warnings };
}

// ---------------------------------------------------------------------------

/**
 * Describes a plugin: everything it declares, as JSON (see `Declaration`).
 * Runs nothing of it but its `allow`s, with made-up callers, and its startup
 * check, on its own configuration with every call it makes refused.
 */
export async function describe(
  plugin: Plugin,
  options: DescribeOptions = {},
): Promise<Declaration> {
  const shared = sharedOf(plugin);
  const { keeps, indexes } = keepsOf(plugin, new Set(shared.map((s) => s.collection)));
  const { tools, calls } = toolsOf(plugin, Object.keys(plugin.actions ?? {}));
  const processors = processorsOf(plugin);
  const check = await checkOf(plugin, options.checkTimeout ?? 1000);
  const settings = options.settings ?? [];
  const found = new Map<string, Set<ResourceRead["found"][number]>>();
  const add = (kind: string, how: ResourceRead["found"][number]) =>
    (found.get(kind) ?? found.set(kind, new Set()).get(kind)!).add(how);
  for (const kind of (plugin as Readable).reads ?? []) add(kind, "declared");
  for (const kind of check?.reads ?? []) add(kind, "check");
  for (const kind of options.reads ?? []) add(kind, "source");
  const powers: Power[] = [
    ...(typeof plugin.who === "function" ? ["who" as const] : []),
    ...(typeof plugin.guard === "function" ? ["guard" as const] : []),
    ...(plugin.labels ? ["labels" as const] : []),
    ...(Object.keys(plugin.workers ?? {}).length ? ["workers" as const] : []),
  ];
  const declaration: Omit<Declaration, "listing"> = {
    format: DECLARATION_FORMAT,
    name: plugin.name,
    ...(options.summary ? { summary: options.summary } : {}),
    requires: [...plugin.requires ?? []],
    ...(options.package ? { package: options.package } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    ...(options.layer ? { layer: options.layer } : {}),
    keeps,
    indexes,
    shared,
    actions: actionsOf(plugin, calls),
    tools,
    views: viewsOf(plugin),
    routes: routesOf(plugin),
    needs: needsOf(settings, check),
    emits: emitsOf(plugin),
    changes: keeps.filter((c) => c.recorded).flatMap((c) =>
      ["created", "updated", "deleted"].map((change) => `${c.name}.${change}`)
    ),
    listens: sorted(processors.flatMap((p) => p.on)),
    processors,
    schedules: schedulesOf(plugin),
    powers,
    resources: {
      provides: providesOf(plugin),
      reads: [...found].map(([kind, how]) => ({
        kind,
        found: (["declared", "check", "source"] as const).filter((h) => how.has(h)),
      })).sort(by((r) => r.kind)),
    },
    adapters: adaptersOf(plugin),
    workers: workersOf(plugin),
    check,
    settings,
  };
  return { ...declaration, listing: listing(declaration) };
}
