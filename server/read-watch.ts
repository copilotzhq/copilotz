/** Batched resource checks, shared only across identical enforced predicates. */
import type { CollectionFilter } from "../runtime/collections/types.ts";

type Watch = { id: string; failed: (error: unknown) => void };
type Group = {
  watches: Set<Watch>;
  query: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
  busy: boolean;
};
const groupsByRuntime = new WeakMap<object, Map<string, Group>>();
const timers = new WeakMap<object, ReturnType<typeof setInterval>>();

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
        [key, item],
      ) => [key, canonical(item)]),
    );
  }
  return value;
}

/** A singleton id restriction is already proved for this exact watcher. */
export function observationReadPolicy(
  policy: CollectionFilter | undefined,
  id: string,
): CollectionFilter | undefined {
  if (policy?.where?.id !== id) return policy;
  const { id: _id, ...where } = policy.where;
  const { where: _where, ...rest } = policy;
  return { ...rest, ...(Object.keys(where).length ? { where } : {}) };
}

export function watchReadAccess(input: {
  runtime: object;
  namespace: string;
  collection: string;
  id: string;
  policy?: CollectionFilter;
  query: (ids: readonly string[]) => Promise<ReadonlySet<string>>;
  failed: (error: unknown) => void;
}): () => void {
  let groups = groupsByRuntime.get(input.runtime);
  if (!groups) groupsByRuntime.set(input.runtime, groups = new Map());
  const key = JSON.stringify([
    input.namespace,
    input.collection,
    canonical(input.policy ?? {}),
  ]);
  let group = groups.get(key);
  if (!group) {
    group = { watches: new Set(), query: input.query, busy: false };
    groups.set(key, group);
  }
  const watch: Watch = { id: input.id, failed: input.failed };
  group.watches.add(watch);
  if (!timers.has(input.runtime)) {
    // Fixed cadence; completion time never shifts the next scheduled check.
    const timer = setInterval(() => {
      for (const group of groups!.values()) {
        if (group.busy) continue;
        group.busy = true;
        void (async () => {
          const ids = [...new Set([...group.watches].map((item) => item.id))];
          for (let offset = 0; offset < ids.length; offset += 1000) {
            if (!group.watches.size) break;
            const active = new Set([...group.watches].map((item) => item.id));
            const batch = ids.slice(offset, offset + 1000).filter((id) =>
              active.has(id)
            );
            if (!batch.length) continue;
            const found = await group.query(batch);
            const missing = new Set(batch.filter((id) => !found.has(id)));
            for (const item of [...group.watches]) {
              if (missing.has(item.id)) {
                item.failed(
                  Object.assign(new Error("Resource was not found."), {
                    code: "thread_not_found",
                    status: 404,
                  }),
                );
              }
            }
          }
        })().catch((error) => {
          for (const item of [...group.watches]) item.failed(error);
        }).finally(() => group.busy = false);
      }
    }, 250);
    timers.set(input.runtime, timer);
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    group!.watches.delete(watch);
    if (!group!.watches.size) groups!.delete(key);
    if (!groups!.size) {
      clearInterval(timers.get(input.runtime));
      timers.delete(input.runtime);
      groupsByRuntime.delete(input.runtime);
    }
  };
}
