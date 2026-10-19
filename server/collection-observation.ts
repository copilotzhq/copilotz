/** Bounded authorized live selections over the existing owner's push and snapshots. */
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type { CollectionQuery } from "../runtime/collections/types.ts";
import { snapshotControl } from "../runtime/collections/snapshot-control.ts";
import { createCoreTableNames } from "../runtime/events/schema.ts";
import { snapshotViewData } from "../runtime/views/renderer.ts";
import type { FacadeContext } from "./context.ts";
import { createHttpReads } from "./reads.ts";
import { viewerIdentity, withServerViewerRead } from "./viewer-authority.ts";

export type CollectionObservationFrame = Readonly<{
  output: Readonly<{
    type: "collection.snapshot";
    collection: string;
    reset: boolean;
    from?: string;
    to: string;
    value: unknown;
    status: "ready" | "missing";
    pending: false;
  }>;
  checkpoint: string;
}>;
type Selection = Readonly<
  { id: string; query?: never } | { id?: never; query: CollectionQuery }
>;
type Capacity = { observations: number; namespaces: Map<string, number> };
const admissions = new WeakMap<object, Capacity>();
const sequence = /^(0|[1-9][0-9]*)$/;
const MAX_OBSERVATIONS = 256;
const MAX_NAMESPACE_OBSERVATIONS = 128;
function failure(code: string, status: number, message: string): Error {
  return Object.assign(new Error(message), { code, status });
}
function selection(value: unknown): Selection {
  const input = snapshotViewData(value, {
    maxDepth: 16,
    maxNodes: 512,
    maxBytes: 16384,
  });
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw failure("invalid_query", 400, "A Collection selector is required.");
  }
  const record = input as Record<string, unknown>;
  if (
    Object.keys(record).some((key) =>
      !["id", "query", "checkpoint"].includes(key)
    )
  ) {
    throw failure(
      "invalid_query",
      400,
      "Unsupported Collection selector field.",
    );
  }
  if (
    record.checkpoint !== undefined &&
    (typeof record.checkpoint !== "string" || record.checkpoint.length > 2048)
  ) {
    throw failure("invalid_query", 400, "Invalid Collection checkpoint.");
  }
  if (
    typeof record.id === "string" && record.id.trim() === record.id &&
    record.id && record.query === undefined
  ) {
    return { id: record.id };
  }
  if (
    record.id !== undefined || !record.query ||
    typeof record.query !== "object" || Array.isArray(record.query)
  ) {
    throw failure(
      "invalid_query",
      400,
      "Select one record or one bounded query.",
    );
  }
  const query = record.query as CollectionQuery;
  if (
    query.after !== undefined || query.before !== undefined ||
    query.include?.length
  ) {
    throw failure(
      "invalid_query",
      400,
      "Live selections use bounded windows without relation includes or page cursors.",
    );
  }
  const limit = query.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw failure(
      "invalid_query",
      400,
      "Live selection limit must be 1 to 1000.",
    );
  }
  return { query: { ...query, limit } };
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fresh attachments explicitly reset to a new atomic snapshot; they do not replay stale rows. */
export async function observeCollection(
  input: Readonly<{
    application: InternalCopilotzApplication;
    context: FacadeContext;
    collection: string;
    selector: unknown;
    reauthorize(signal: AbortSignal): Promise<FacadeContext>;
  }>,
): Promise<ReadableStream<CollectionObservationFrame>> {
  const selected = selection(input.selector);
  const fixedIdentity = viewerIdentity(input.context);
  const definition = Object.values(input.application.plugins.collections)
    .find((candidate) => candidate.name === input.collection);
  if (definition?.ownerPolicy !== "required") {
    throw failure(
      "forbidden",
      403,
      "Live Collections require a current owner policy.",
    );
  }
  const { databaseSchema, namespace } = input.context.serverScope;
  if (!databaseSchema || !namespace) {
    throw failure("forbidden", 403, "Viewer scope is required.");
  }
  const runtime = databaseSchema === input.application.config.databaseSchema
    ? input.application
    : await input.application.databaseScope(databaseSchema);
  let capacity = admissions.get(runtime);
  if (!capacity) {
    admissions.set(
      runtime,
      capacity = {
        observations: 0,
        namespaces: new Map(),
      },
    );
  }
  if (
    capacity.observations >= MAX_OBSERVATIONS ||
    (capacity.namespaces.get(namespace) ?? 0) >= MAX_NAMESPACE_OBSERVATIONS
  ) {
    throw failure(
      "collection_observation_capacity",
      503,
      "Collection observation capacity exceeded.",
    );
  }
  const cancellation = new AbortController();
  const signal = cancellation.signal;
  const scopeHash = await digest(fixedIdentity);
  const selectorHash = await digest([input.collection, selected]);
  if (
    capacity.observations >= MAX_OBSERVATIONS ||
    (capacity.namespaces.get(namespace) ?? 0) >= MAX_NAMESPACE_OBSERVATIONS
  ) {
    throw failure(
      "collection_observation_capacity",
      503,
      "Collection observation capacity exceeded.",
    );
  }
  capacity.observations++;
  capacity.namespaces.set(
    namespace,
    (capacity.namespaces.get(namespace) ?? 0) + 1,
  );
  let closed = false;
  let stop: (() => void) | undefined;
  let controller: ReadableStreamDefaultController<CollectionObservationFrame>;
  let dirty = true;
  let busy = false;
  let queued = false;
  let previous: string | undefined;
  let previousValue: string | undefined;
  let retainedIds: string[] = [];
  let previousConstraints: string | undefined;
  let epoch: string | undefined;
  const finish = (error?: unknown) => {
    if (closed) return;
    closed = true;
    capacity!.observations--;
    const remaining = (capacity!.namespaces.get(namespace) ?? 1) - 1;
    if (remaining) capacity!.namespaces.set(namespace, remaining);
    else capacity!.namespaces.delete(namespace);
    cancellation.abort(error);
    stop?.();
    input.context.serverSignal.removeEventListener("abort", onAbort);
    try {
      if (error !== undefined) controller?.error(error);
      else controller?.close();
    } catch { /* A consumer may already have cancelled its readable side. */ }
  };
  const onAbort = () =>
    finish(
      input.context.serverSignal.reason ??
        new DOMException("Aborted", "AbortError"),
    );
  const scan = async () => {
    if (closed || busy) return;
    busy = true;
    try {
      while (dirty && !closed) {
        dirty = false;
        signal.throwIfAborted();
        const current = await input.reauthorize(signal);
        signal.throwIfAborted();
        if (viewerIdentity(current) !== fixedIdentity) {
          throw failure("revoked", 403, "Viewer authority changed.");
        }
        const constraints = JSON.stringify(
          current.serverConstraints.collections ?? null,
        );
        const snapshot = await withServerViewerRead(
          current,
          () =>
            runtime.collections.readSnapshot(
              { namespace },
              async (context) => {
                const transaction = snapshotControl(context)?.snapshot;
                if (!transaction) {
                  throw new Error(
                    "Collection snapshots require owner snapshot control.",
                  );
                }
                const read = await createHttpReads(
                  input.application,
                  current.serverScope,
                  current.serverConstraints,
                  {
                    viewer: current,
                    collections: context.collections,
                  },
                );
                const row = (await transaction.query<
                  { last_seq: string | number; epoch: string | number }
                >(
                  `SELECT last_seq,epoch FROM ${
                    createCoreTableNames(databaseSchema).owner_epochs
                  } WHERE owner='schema'`,
                )).rows[0];
                if (
                  !row || !sequence.test(String(row.last_seq))
                ) throw new Error("Owner snapshot head is unavailable.");
                const unchanged = previous === String(row.last_seq) &&
                  constraints === previousConstraints;
                // Idle authority checks retain the original predicate and only
                // touch the already disclosed IDs, not the entire query window.
                // The ordinary Collection policy still checks read and each result.
                const query = selected.query && unchanged
                  ? {
                    ...selected.query,
                    all: [...(selected.query.all ?? []), {
                      filter: { field: "id", in: retainedIds },
                    }],
                  }
                  : selected.query;
                const checked = selected.id !== undefined
                  ? await read.get(input.collection, selected.id, { signal })
                  : await read.list(input.collection, query, { signal });
                const value = unchanged ? JSON.parse(previousValue!) : checked;
                return {
                  value: snapshotViewData(value, {
                    maxBytes: 1024 * 1024,
                    maxNodes: 40000,
                  }),
                  sequence: String(row.last_seq),
                  epoch: String(row.epoch),
                };
              },
            ),
        );
        signal.throwIfAborted();
        if (epoch !== undefined && snapshot.epoch !== epoch) {
          throw failure(
            "observation_reset_required",
            409,
            "Owner changed; reset the Collection selection.",
          );
        }
        if (
          previous !== undefined &&
          BigInt(snapshot.sequence) < BigInt(previous)
        ) {
          throw failure(
            "observation_reset_required",
            409,
            "Collection sequence moved backwards.",
          );
        }
        const serialized = JSON.stringify(snapshot.value);
        if (
          previous === snapshot.sequence && previousValue === serialized &&
          previousConstraints === constraints
        ) continue;
        if ((controller.desiredSize ?? 0) <= 0) {
          throw failure(
            "observation_reset_required",
            409,
            "Collection observer is behind; reset its snapshot.",
          );
        }
        const checkpoint = JSON.stringify({
          v: 1,
          scope: scopeHash,
          selector: selectorHash,
          epoch: snapshot.epoch,
          sequence: snapshot.sequence,
        });
        controller.enqueue({
          output: {
            type: "collection.snapshot",
            collection: input.collection,
            reset: previous === undefined,
            ...(previous === undefined ? {} : { from: previous }),
            to: snapshot.sequence,
            value: snapshot.value,
            status: snapshot.value === null ? "missing" : "ready",
            pending: false,
          },
          checkpoint,
        });
        previous = snapshot.sequence;
        previousValue = serialized;
        retainedIds = Array.isArray(snapshot.value)
          ? snapshot.value.flatMap((row) =>
            row && typeof row === "object" && typeof row.id === "string"
              ? [row.id]
              : []
          )
          : [];
        previousConstraints = constraints;
        epoch = snapshot.epoch;
      }
    } catch (error) {
      finish(error);
    } finally {
      busy = false;
      if (dirty && !closed) schedule();
    }
  };
  const schedule = () => {
    if (closed || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      void scan();
    });
  };
  const stream = new ReadableStream<CollectionObservationFrame>({
    start(value) {
      controller = value;
    },
    cancel(reason) {
      finish(reason);
    },
  }, { highWaterMark: 1 });
  try {
    input.context.serverSignal.addEventListener("abort", onAbort, {
      once: true,
    });
    input.context.serverSignal.throwIfAborted();
    stop = await runtime.operations.onChange((_id, detail) => {
      if (closed) return;
      if (detail.kind === "reset") {
        finish(
          failure(
            "observation_reset_required",
            409,
            "Owner observation reset.",
          ),
        );
        return;
      }
      dirty = true;
      schedule();
    }, { namespace });
    if (closed) stop();
    else schedule();
  } catch (error) {
    finish(error);
    throw error;
  }
  return stream;
}
