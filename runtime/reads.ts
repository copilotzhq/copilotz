/**
 * Read-only access over a `run` of ops: what queries reach, and Views through
 * them. An executor runs it over its job's calls to the owner; the owner, for
 * Views it observes, over its own reads.
 */
import { collection, type Query, type Run } from "./collection.ts";
import type { Context, ReadContext } from "./define.ts";
import type { Metrics } from "./metrics.ts";
import { isRead } from "./ops.ts";
import { invalid, json, readCall, type Registry } from "./registry.ts";
import type { Actor, Edge } from "./store.ts";
import { renderer } from "./views.ts";

export function reading(
  registry: Registry,
  run: Run,
  record: Context["record"],
  metrics: Metrics,
  actor?: Actor,
): ReadContext {
  const reads: Run = (op) =>
    isRead(op) ? run(op) : Promise.reject(invalid("Queries are read-only"));
  const query = querying(registry, reads, record, metrics, actor);
  const ctx: ReadContext = {
    db: { collection: (name) => collection(name, reads, query) },
    graph: { edges: (query) => reads({ op: "edges", query }) as Promise<Edge[]> },
    render: renderer(registry.views, () => reading(registry, reads, record, metrics, actor)),
    record,
    metrics,
    resources: registry.resources,
    adapters: registry.adapters,
    ...(actor ? { actor } : {}),
    call: (action, input) => readCall(registry, ctx, ctx.call, action, input),
  };
  return ctx;
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
  actor?: Actor,
): Query =>
async (name, queryName, params) => {
  const def = registry.collections[name]?.queries?.[queryName];
  if (!def) throw invalid(`Unknown query "${name}.${queryName}"`);
  const ctx = reading(registry, run, record, metrics, actor);
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
export function startup(registry: Registry, metrics: Metrics): ReadContext["call"] {
  const none = () => {
    throw invalid("Nothing is stored yet: a startup check reads only the configuration");
  };
  const reads: Omit<ReadContext, "call"> = {
    db: { collection: none },
    graph: { edges: none },
    render: none,
    record: none,
    metrics,
    resources: registry.resources,
    adapters: registry.adapters,
  };
  const call: ReadContext["call"] = (action, input) =>
    readCall(registry, reads, call, action, input);
  return call;
}
