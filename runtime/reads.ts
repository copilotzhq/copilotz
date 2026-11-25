/**
 * Read-only access over a `run` of ops: what queries reach, and Views through
 * them. An executor runs it over its job's calls to the owner; the owner, for
 * Views it observes, over its own reads.
 */
import { collection, type Query, type Run } from "./collection.ts";
import type { AllowContext, Context, QueryDef, ReadContext } from "./define.ts";
import type { Metrics } from "./metrics.ts";
import { isRead } from "./ops.ts";
import {
  described,
  invalid,
  json,
  queriesOf,
  readCall,
  type Registry,
  unknown,
} from "./registry.ts";
import type { Actor, Edge } from "./store.ts";
import { presenter } from "./views.ts";
import { forbidden } from "./errors.ts";
import { acting, allows, inScope, whereOf } from "./actor.ts";

/** What keeps what rules work out (`ReadContext.kept`): the owner's, for its rules' reads. */
export type Keeper = <T>(
  key: string,
  work: (ctx: ReadContext) => Promise<T>,
  ctx: ReadContext,
) => Promise<T>;

/** Keeps nothing: what's worked out is worked out each time. */
const unkept: Keeper = (_key, work, ctx) => work(ctx);

/**
 * How a reader reads as someone else: for an unrecorded Action it calls,
 * acting as the system or a grant (`ctx.as`), as it would from an Action.
 */
export type RunAs = (actor: Actor | undefined) => Run;

export function reading(
  registry: Registry,
  run: Run,
  record: Context["record"],
  metrics: Metrics,
  fetch: typeof globalThis.fetch,
  actor?: Actor,
  keeper: Keeper = unkept,
  runAs?: RunAs,
  outsideQuery = false,
): ReadContext {
  const reads: Run = (op) =>
    isRead(op) ? run(op) : Promise.reject(invalid("Queries are read-only"));
  const query = querying(registry, reads, record, metrics, fetch, actor, runAs, outsideQuery);
  // An Action it calls, acting as someone else, reads as them: what that reader can't, fails.
  const as = runAs
    ? (other?: Actor) => {
      const who = acting(actor, other);
      return reading(registry, runAs(who), record, metrics, fetch, who, unkept, runAs);
    }
    : undefined;
  const where = whereOf(actor);
  const ctx: ReadContext = {
    db: { collection: (name) => collection(name, reads, query) },
    describe: () => described(registry),
    graph: { edges: (query) => reads({ op: "edges", query }) as Promise<Edge[]> },
    render: presenter(
      registry.views,
      () => reading(registry, reads, record, metrics, fetch, actor, unkept, runAs),
    ),
    record,
    metrics,
    fetch,
    resources: registry.resources,
    adapters: registry.adapters,
    ...(actor ? { actor } : {}),
    ...(where !== undefined ? { in: where } : {}),
    kept: (key, work) => keeper(key, work, ctx),
    call: (action, input) => readCall(registry, ctx, ctx.call, action, input, as),
  };
  return ctx;
}

/** Admission for an outside query, including each refresh of a watched query. */
export function queryAllowed(
  def: QueryDef | undefined,
  name: string,
  params: unknown,
  actor: Actor | undefined,
  reads: (who: Actor) => AllowContext,
) {
  return !actor || actor.kind === "system" || (typeof def === "object" && !!def.allow &&
    inScope(actor, "query", name) && allows(def.allow, actor, params, reads));
}

/**
 * Runs a collection's named query here, over the caller's reads: in a
 * transaction it sees the transaction's own writes.
 */
export const querying = (
  registry: Registry,
  run: Run,
  record: Context["record"],
  metrics: Metrics,
  fetch: typeof globalThis.fetch,
  actor?: Actor,
  runAs?: RunAs,
  outsideQuery = false,
): Query =>
async (name, queryName, params) => {
  const def = registry.collections[name]?.queries?.[queryName];
  if (!def) throw unknown("query", `${name}.${queryName}`, queriesOf(registry));
  const ctx = reading(registry, run, record, metrics, fetch, actor, unkept, runAs);
  if (
    outsideQuery && actor &&
    !await queryAllowed(def, `${name}.${queryName}`, params, actor, (who) => {
      if (who === actor) return ctx;
      if (!runAs) throw invalid("This read can't check another actor's permission");
      return reading(registry, runAs(who), record, metrics, fetch, who, unkept, runAs);
    })
  ) {
    throw forbidden(`${actor.kind} ${actor.id} may not run "${name}.${queryName}".`);
  }
  return await (typeof def === "function" ? def : def.run)(
    ctx.db.collection(name),
    json(params),
    ctx,
  );
};

/**
 * What startup checks call Actions with: the configuration, and no data yet
 * (reading or recording fails).
 */
export function startup(
  registry: Registry,
  metrics: Metrics,
  fetch: typeof globalThis.fetch,
): ReadContext["call"] {
  const none = () => {
    throw invalid("Nothing is stored yet: a startup check reads only the configuration");
  };
  const reads: Omit<ReadContext, "call"> = {
    db: { collection: none },
    describe: () => described(registry),
    graph: { edges: none },
    render: none,
    record: none,
    kept: none,
    metrics,
    fetch,
    resources: registry.resources,
    adapters: registry.adapters,
  };
  const call: ReadContext["call"] = (action, input) =>
    readCall(registry, reads, call, action, input);
  return call;
}
