import { assertJsonValue } from "../json.ts";
import {
  createResolvedCollectionReader,
  windowContentOptions,
} from "../collections/resolved-read.ts";
import type { ContentResolver } from "../content/resolver.ts";
import { withRetainedAuthority } from "../authorization/binding.ts";
import type {
  AuthorityObservation,
  AuthorizationOwner,
} from "../authorization/owner.ts";
import { retainedAuthority } from "../authorization/authority.ts";
import {
  createSchemaCommandRunner,
  type DatabaseOwner,
} from "../engine/commands.ts";
import { attachOwnerPush, type OwnerPushSubscription } from "../events/push.ts";
import { afterSqlCommit, type SqlSession } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { mapNode, type NodeRow } from "../collections/reducer.ts";
import { compareCodePoints } from "../collections/predicate.ts";
import { compileLiveFilters, queryRefused } from "./predicate.ts";
import { stableStringify } from "../collections/equal.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  CollectionFilter,
  CollectionQuery,
  CollectionRecord,
} from "../collections/types.ts";
import type {
  CollectionObserver,
  CollectionSubscription,
  SubscriptionFrame,
} from "./types.ts";

type DataFrame = Extract<SubscriptionFrame, { checkpoint: string }>;
type Cache = {
  rows: Map<string, CollectionRecord>;
  seq: string;
  localSeq: string;
  rowBytes: Map<string, number>;
  bytes: number;
  push: OwnerPushSubscription;
  states: Set<State>;
};
type State = {
  identity: string;
  principal: string;
  matches: (row: CollectionRecord) => boolean;
  policyMatches: (row: CollectionRecord) => boolean;
  members: string[];
  filter: CollectionFilter;
  cache: Cache;
  query: CollectionQuery;
  progressOnly: boolean;
  rows: readonly CollectionRecord[];
  seq: string;
  history: DataFrame[];
  bytes: number;
  expires: number;
  reader?: Reader;
};
type Reader = {
  queue: SubscriptionFrame[];
  bytes: number;
  closed: boolean;
  ready: boolean;
  authorization?: AuthorityObservation;
  wake?: () => void;
  stop(reason: "reset" | "revoked", detail: string): void;
  detach(): void;
};
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const compare = compareCodePoints;
const capacity = (message: string) =>
  Object.assign(new RangeError(message), {
    code: "subscription_capacity_exceeded",
  });
export type SubscriptionLimits = Partial<typeof DEFAULT_SUBSCRIPTION_LIMITS>;
export const DEFAULT_SUBSCRIPTION_LIMITS = {
  maxFrames: 64,
  maxBytes: 1024 * 1024,
  retentionMs: 5 * 60_000,
  maxStates: 256,
  maxStatesPerPrincipal: 32,
  maxDetachedPerPrincipal: 16,
  maxPredicateNodes: 64,
  maxPredicateValues: 32,
  maxQueryBytes: 16 * 1024,
  maxPendingAdmissions: 256,
  maxCollections: 32,
  maxRows: 10_000,
  maxCacheBytes: 16 * 1024 * 1024,
};

/** One cache/listener per Collection and row/progress mode, never SQL per commit. */
export function createCollectionObserver(
  options: {
    session: SqlSession;
    schema: string;
    owner: DatabaseOwner;
    authorization: AuthorizationOwner;
    collections: Readonly<Record<string, CollectionDefinition>>;
    contentResolver?: ContentResolver;
  } & SubscriptionLimits,
): CollectionObserver {
  const limits = {
    ...DEFAULT_SUBSCRIPTION_LIMITS,
    ...Object.fromEntries(
      Object.keys(DEFAULT_SUBSCRIPTION_LIMITS).filter((key) =>
        options[key as keyof SubscriptionLimits] !== undefined
      )
        .map((key) => [key, options[key as keyof SubscriptionLimits]]),
    ),
  };
  const { maxFrames, maxBytes, retentionMs } = limits;
  if (
    !Object.values(limits).every((value) =>
      Number.isSafeInteger(value) && value > 0
    )
  ) {
    throw new RangeError("Subscription limits must be positive integers.");
  }
  const caches = new Map<string, Cache>(), states = new Set<State>();
  let admissions = Promise.resolve(), waiting = 0;
  const run = createSchemaCommandRunner(
    options.session,
    options.schema,
    () => Promise.resolve(options.owner),
  );
  const tables = createCoreTableNames(options.schema);
  const forget = (state: State) => {
    states.delete(state);
    state.cache.states.delete(state);
    state.history = [];
    state.bytes = 0;
    if (!state.cache.states.size) {
      state.cache.push.close();
      for (const [key, cache] of caches) {
        if (cache === state.cache) caches.delete(key);
      }
    }
  };
  const trimDetached = (principal?: string, pressure?: () => boolean) => {
    const detached = [...states].filter((s) =>
      !s.reader && (!principal || s.principal === principal)
    )
      .sort((a, b) => a.expires - b.expires);
    while (
      detached.length &&
      (pressure ? pressure() : detached.length > limits.maxDetachedPerPrincipal)
    ) forget(detached.shift()!);
  };
  const select = (state: State) =>
    state.progressOnly ? [] : state.members
      .slice(0, state.query.limit ?? 100).map((id) =>
        state.cache.rows.get(id)!
      );
  const updateMember = (
    state: State,
    id: string,
    record: CollectionRecord | null,
  ) => {
    const direction = state.query.order?.direction === "desc" ? -1 : 1;
    let lo = 0, hi = state.members.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(state.members[mid], id) * direction < 0) lo = mid + 1;
      else hi = mid;
    }
    const included = state.members[lo] === id;
    const matches = record !== null && state.matches(record);
    if (included && !matches) state.members.splice(lo, 1);
    else if (!included && matches) state.members.splice(lo, 0, id);
  };
  const push = (state: State, frame: DataFrame) => {
    const size = bytes(frame);
    if (size > maxBytes) {
      state.reader?.stop("reset", "capacity");
      forget(state);
      return;
    }
    state.history.push(frame);
    state.bytes += size;
    while (state.history.length > maxFrames || state.bytes > maxBytes) {
      state.bytes -= bytes(state.history.shift()!);
    }
    const reader = state.reader;
    if (!reader || reader.closed) return;
    if (reader.queue.length >= maxFrames || reader.bytes + size > maxBytes) {
      reader.stop("reset", "slow_consumer");
      return;
    }
    reader.queue.push(frame);
    reader.bytes += size;
    reader.wake?.();
  };
  const resetCache = (cache: Cache, reason: string) => {
    for (const state of [...cache.states]) {
      state.reader?.stop("reset", reason);
      forget(state);
    }
  };
  const snapshot = (state: State) => {
    state.rows = select(state);
    state.seq = state.cache.localSeq;

    push(state, {
      t: "snapshot",
      checkpoint: crypto.randomUUID(),
      sequence: state.seq,
      rows: state.rows,
      complete: true,
    });
  };
  options.owner.signal.addEventListener("abort", () => {
    for (const cache of [...caches.values()]) resetCache(cache, "takeover");
  }, { once: true });
  return async (value, alias, input = {}, observation = {}) => {
    observation.signal?.throwIfAborted();
    if (
      observation.checkpoint !== undefined &&
      (typeof observation.checkpoint !== "string" || !observation.checkpoint ||
        observation.checkpoint.length > 16384)
    ) throw new TypeError("Invalid subscription checkpoint.");
    if (
      observation.progressOnly !== undefined &&
      typeof observation.progressOnly !== "boolean"
    ) {
      throw new TypeError("Invalid progress-only selection.");
    }
    if (
      observation.progressOnly &&
      (Object.keys(input).length || observation.content)
    ) {
      throw new TypeError(
        "Progress-only subscriptions do not select rows or content.",
      );
    }
    const progressOnly = observation.progressOnly === true;
    const authority = retainedAuthority(value);
    // Worker attempts are lease-bound, not renewable device admissions. Their
    // retirement cannot be represented by this credential notice/deadline gate.
    if (authority.validity.kind !== "credential") {
      throw new TypeError(
        "Subscription requires renewable credential authority.",
      );
    }
    const definition = options.collections[alias];
    if (!definition) throw new TypeError("Unknown Collection.");
    const query = structuredClone(input);
    // id uses deterministic string ordering. Locale-dependent scalar/text queries require
    // a shared SQL-compatible index; never approximate them in a live selection.
    if (
      query.all !== undefined && !Array.isArray(query.all) ||
      query.after || query.before || query.text || query.include?.length ||
      query.order &&
        (query.order.field !== "id" ||
          ![undefined, "asc", "desc"].includes(query.order.direction)) ||
      query.limit !== undefined &&
        (!Number.isSafeInteger(query.limit) || query.limit < 1 ||
          query.limit > 1000) ||
      Object.keys(query).some((key) =>
        !["filter", "where", "contains", "containsAny", "all", "limit", "order"]
          .includes(key)
      )
    ) {
      throw queryRefused(
        "Subscription requires a bounded id-ordered Collection query without cursors, search or includes.",
      );
    }
    const queryMatches = compileLiveFilters(
      [query, ...(query.all ?? [])],
      limits,
      definition.schema,
    );
    // Untrusted options must be validated before reserving the serialized queue.
    if (observation.content !== undefined) {
      try {
        assertJsonValue(observation.content, {
          maxDepth: 16,
          maxNodes: limits.maxPredicateNodes,
          omitUndefinedProperties: true,
        });
        if (bytes(observation.content) > limits.maxQueryBytes) {
          throw queryRefused(
            "Subscription content options exceed the byte limit",
          );
        }
      } catch (error) {
        throw queryRefused(
          error instanceof Error ? error.message : "Invalid content options",
        );
      }
    }
    const principal = stableStringify([
      authority.scope.tenant,
      authority.principal,
    ]);
    const identity = stableStringify({
      principal: authority.principal,
      scope: authority.scope,
      policy: authority.policy,
      basis: authority.authorityBasis,
      alias,
      query,
      content: observation.content,
      progressOnly,
      schema: definition.schema,
      name: definition.name,
    });
    if (waiting >= limits.maxPendingAdmissions) {
      throw capacity("Subscription admission capacity exceeded.");
    }
    waiting++;
    const preceding = admissions, admitted = Promise.withResolvers<void>();
    admissions = admitted.promise;
    await preceding;
    for (const state of [...states]) {
      if (!state.reader && state.expires <= Date.now()) forget(state);
    }
    let state: State | undefined;
    if (observation.checkpoint) {
      state = [...states].find((s) =>
        s.identity === identity &&
        s.history.some((frame) => frame.checkpoint === observation.checkpoint)
      );
    }
    const reader: Reader = {
      queue: [],
      bytes: 0,
      closed: false,
      ready: false,
      stop(t, reason) {
        if (reader.closed) return;
        reader.queue = [{ t, reason }];
        reader.bytes = 0;
        reader.closed = true;
        reader.authorization?.close();
        reader.wake?.();
        if (state?.reader === reader) {
          state.reader = undefined;
          state.expires = Date.now() + retentionMs;
          trimDetached(state.principal);
        }
        observation.signal?.removeEventListener("abort", reader.detach);
      },
      detach() {
        if (!reader.closed) reader.stop("reset", "detached");
        reader.queue = [];
        reader.wake?.();
      },
    };
    const resolveRows = createResolvedCollectionReader(
      (rows: readonly CollectionRecord[]) => Promise.resolve(rows),
      definition,
      authority.scope.namespace,
      options.contentResolver,
    );
    const project = async (
      frame: SubscriptionFrame,
    ): Promise<SubscriptionFrame> => {
      if (
        !observation.content || frame.t === "reset" || frame.t === "revoked"
      ) return structuredClone(frame);
      return await withRetainedAuthority(
        authority,
        observation.signal ?? options.owner.signal,
        async () => {
          const rows = frame.t === "snapshot"
            ? frame.rows
            : frame.changes.flatMap((change) =>
              change.record ? [change.record] : []
            );
          const resolved = await resolveRows(rows, {
            content: windowContentOptions(observation.content),
            signal: observation.signal,
          });
          if (frame.t === "snapshot") {
            return {
              ...frame,
              rows: resolved as readonly CollectionRecord[],
            };
          }
          let index = 0;
          return {
            ...frame,
            changes: frame.changes.map((change) => ({
              ...change,
              record: change.record
                ? resolved[index++] as CollectionRecord
                : null,
            })),
          };
        },
      );
    };
    let consuming = false;
    const frames: AsyncIterable<SubscriptionFrame> = {
      async *[Symbol.asyncIterator]() {
        if (consuming) throw new Error("Subscription already has a consumer.");
        consuming = true;
        try {
          for (;;) {
            if (reader.closed) {
              const frame = reader.queue.shift();
              if (frame) yield structuredClone(frame);
              return;
            }
            try {
              if (
                reader.ready && reader.authorization?.current() &&
                reader.queue.length
              ) {
                const frame = reader.queue[0];
                const projected = await project(frame);
                if (
                  reader.closed || reader.queue[0] !== frame ||
                  !reader.authorization.current()
                ) continue;
                reader.queue.shift();
                reader.bytes -= bytes(frame);
                yield projected;
                continue;
              }
            } catch (error) {
              reader.stop(
                (error as { code?: string }).code === "revoked"
                  ? "revoked"
                  : "reset",
                "authorization",
              );
              continue;
            }
            await new Promise<void>((resolve) => {
              reader.wake = resolve;
            });
            reader.wake = undefined;
          }
        } finally {
          reader.detach();
        }
      },
    };
    let admissionError: unknown;
    try {
      const attached = [...states].filter((s) => s.reader && s !== state);
      if (
        attached.length >= limits.maxStates ||
        attached.filter((s) => s.principal === principal).length >=
          limits.maxStatesPerPrincipal
      ) {
        throw capacity("Subscription active state quota exceeded.");
      }
      if (!state && states.size >= limits.maxStates) {
        trimDetached(undefined, () => states.size >= limits.maxStates);
      }
      if (observation.content) {
        await resolveRows([], { content: observation.content });
      }
      await run("subscription.attach", {}, async (_, command) => {
        observation.signal?.throwIfAborted();
        command.afterCommit(() => {
          reader.ready = true;
          reader.wake?.();
        });
        let filter: CollectionFilter | undefined;
        let policyMatches: State["policyMatches"] | undefined;
        reader.authorization = await options.authorization.observe(authority, {
          collection: alias,
          query,
        }, (error) => {
          reader.stop(
            (error as { code?: string }).code === "revoked"
              ? "revoked"
              : "reset",
            "authorization",
          );
        }, (decision) => {
          const next = decision.constraints.collections?.[alias] ??
            decision.constraints.collections?.[definition.name];
          if (!next) {
            reader.stop("revoked", "authorization");
            return;
          }
          try {
            policyMatches = compileLiveFilters(
              [next],
              limits,
              definition.schema,
            );
          } catch (error) {
            admissionError = error;
            reader.stop("reset", "subscription_query_refused");
            if (state) forget(state);
            return;
          }
          filter = next;
          if (
            state && stableStringify(state.filter) !== stableStringify(next)
          ) {
            reader.stop("reset", "scope");
            forget(state);
          }
          reader.wake?.();
        });
        // Admission callback is delivered at commit. Snapshot creation follows it.
        if (observation.checkpoint && !state) {
          afterSqlCommit(
            command.transaction,
            () => reader.stop("reset", "retention_or_scope"),
          );
          return;
        }
        if (state) {
          const resumed = state;
          afterSqlCommit(command.transaction, () => {
            if (reader.closed) return;
            if (
              !states.has(resumed) ||
              !resumed.history.some((frame) =>
                frame.checkpoint === observation.checkpoint
              )
            ) {
              reader.stop("reset", "retention");
              return;
            }
            resumed.reader?.stop("reset", "reconnected");
            resumed.reader = reader;
            const index = resumed.history.findIndex((f) =>
              f.checkpoint === observation.checkpoint
            );
            reader.queue = resumed.history.slice(index + 1);
            reader.bytes = reader.queue.reduce((n, f) => n + bytes(f), 0);
            reader.wake?.();
          });
          return;
        }
        const key = JSON.stringify([
          authority.scope.namespace,
          definition.name,
          progressOnly,
        ]);
        let cache = caches.get(key);
        if (!cache) {
          if (caches.size >= limits.maxCollections) {
            trimDetached(undefined, () => caches.size >= limits.maxCollections);
          }
          if (caches.size >= limits.maxCollections) {
            throw capacity("Subscription Collection capacity exceeded.");
          }
          const rows = progressOnly
            ? []
            : (await command.transaction.query<NodeRow>(
              `SELECT id,namespace,data FROM ${tables.nodes} WHERE namespace=$1 AND type=$2 LIMIT ${
                limits.maxRows + 1
              }`,
              [authority.scope.namespace, definition.name],
            )).rows.map(mapNode);
          if (
            rows.length > limits.maxRows || bytes(rows) > limits.maxCacheBytes
          ) {
            throw capacity("Subscription Collection capacity exceeded.");
          }
          const ordinal = await command.transaction.query<{ seq: string }>(
            `SELECT COUNT(*)::text AS seq FROM ${tables.events} WHERE namespace=$1`,
            [authority.scope.namespace],
          );
          const shared: Cache = {
            localSeq: ordinal.rows[0].seq,
            rows: new Map(rows.map((r) => [r.id, r])),
            rowBytes: new Map(rows.map((r) => [r.id, bytes(r) + 1])),
            bytes: bytes(rows),
            seq: "0",
            states: new Set(),
            push: undefined!,
          };
          shared.push = await attachOwnerPush(
            command.transaction,
            options.schema,
            (frame) => {
              if (frame.kind === "reset") {
                resetCache(shared, frame.reason);
                return;
              }
              // Heartbeats detect lost pushes; they never certify unapplied data.
              if (frame.kind === "heartbeat") {
                if (BigInt(frame.headSeq) > BigInt(shared.seq)) {
                  resetCache(shared, "gap");
                }
                return;
              }
              if (BigInt(frame.headSeq) <= BigInt(shared.seq)) {
                return;
              }
              if (BigInt(frame.headSeq) !== BigInt(shared.seq) + 1n) {
                resetCache(shared, "gap");
                return;
              }
              const change = frame.kind === "change"
                ? frame.change.collectionChange
                : undefined;
              const old = change?.previous ??
                (change && shared.rows.get(change.id));
              if (!progressOnly && change?.collection === definition.name) {
                shared.bytes -= shared.rowBytes.get(change.id) ?? 0;
                shared.rowBytes.delete(change.id);
                if (change.record) {
                  shared.rows.set(change.id, change.record);
                  const size = bytes(change.record) + 1;
                  shared.rowBytes.set(change.id, size);
                  shared.bytes += size;
                } else shared.rows.delete(change.id);
                if (
                  shared.rows.size > limits.maxRows ||
                  shared.bytes > limits.maxCacheBytes
                ) {
                  resetCache(shared, "capacity");
                  return;
                }
              }
              shared.seq = frame.headSeq;
              if (frame.kind !== "change") return;
              shared.localSeq = String(BigInt(shared.localSeq) + 1n);
              if (change && change.collection !== definition.name) return;
              for (const item of [...shared.states]) {
                if (!item.reader && item.expires <= Date.now()) {
                  forget(item);
                  continue;
                }
                // No public signal (including progress) for an invisible mutation.
                if (
                  change && !(old && item.policyMatches(old)) &&
                  !(change.record && item.policyMatches(change.record))
                ) continue;
                if (progressOnly && !change) continue;
                if (!item.progressOnly && change) {
                  updateMember(item, change.id, change.record);
                }
                const next = select(item);
                const previous = new Map(item.rows.map((r) => [r.id, r]));
                const current = new Map(next.map((r) => [r.id, r]));
                const from = item.seq;
                item.seq = shared.localSeq;
                const changes = [
                  ...new Set([...previous.keys(), ...current.keys()]),
                ].sort(compare)
                  .filter((id) =>
                    previous.get(id) !== current.get(id) &&
                    stableStringify(previous.get(id)) !==
                      stableStringify(current.get(id))
                  )
                  .map((id) => ({
                    seq: item.seq,
                    id,
                    record: current.get(id) ?? null,
                  }));
                item.rows = next;
                push(item, {
                  t: "batch",
                  checkpoint: crypto.randomUUID(),
                  from,
                  to: item.seq,
                  changes,
                  collectionChanged: Boolean(change),
                });
              }
            },
            { namespace: authority.scope.namespace },
          );
          shared.seq = shared.push.cursor;
          cache = shared;
          afterSqlCommit(command.transaction, () => caches.set(key, shared));
        }
        const selectedCache = cache;
        afterSqlCommit(command.transaction, () => {
          if (reader.closed || !filter || !policyMatches) {
            if (!selectedCache.states.size) {
              selectedCache.push.close();
              for (const [key, cached] of caches) {
                if (cached === selectedCache) caches.delete(key);
              }
            }
            return;
          }
          state = {
            identity,
            principal,
            policyMatches,
            matches: (row) => policyMatches!(row) && queryMatches(row),
            members: [],
            progressOnly,
            filter,
            cache: selectedCache,
            query,
            rows: [],
            seq: "0",
            history: [],
            bytes: 0,
            expires: Date.now() + retentionMs,
            reader,
          };
          if (!progressOnly) {
            state.members = [...selectedCache.rows.values()].filter(
              state.matches,
            ).map((row) => row.id)
              .sort((a, b) =>
                compare(a, b) * (query.order?.direction === "desc" ? -1 : 1)
              );
          }
          states.add(state);
          selectedCache.states.add(state);
          snapshot(state);
          reader.wake?.();
        });
      });
      if (admissionError) throw admissionError;
    } catch (error) {
      reader.detach();
      throw error;
    } finally {
      waiting--;
      admitted.resolve();
    }
    observation.signal?.addEventListener("abort", reader.detach, {
      once: true,
    });
    if (observation.signal?.aborted) reader.detach();
    return {
      frames,
      detach: reader.detach,
      isActive: () => !reader.closed,
      canPublish() {
        if (reader.closed || !reader.ready) return false;
        try {
          return Boolean(reader.authorization?.current());
        } catch {
          return false;
        }
      },
    } satisfies CollectionSubscription;
  };
}
