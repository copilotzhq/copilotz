import type {
  BodyHead,
  BodyMaintenanceListInput,
  BodyStore,
  BodyStoreAdapter,
  MutableBodyHead,
  PutBodyInput,
  SealBodyInput,
  TrustedBodyScope,
} from "./body-store.ts";
import { readBodyBytes, readBodyRange } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { createContentError } from "./errors.ts";

export type PromotedBodyStoreOptions = Readonly<{
  /** Durable cluster-reachable staging, normally scoped PostgreSQL. */
  staging: BodyStore;
  /** Durable cluster-reachable immutable Ready storage, normally GCS. */
  ready: BodyStore;
}>;

export type PromotedBodyStoreAdapterOptions = Readonly<{
  staging: BodyStoreAdapter;
  ready: BodyStoreAdapter;
}>;

function conflict(message: string): Error {
  return createContentError("asset_conflict", message);
}

function isReady(
  head: BodyHead | MutableBodyHead | null,
): head is BodyHead {
  return head?.state === "ready";
}

function isActive(
  head: BodyHead | MutableBodyHead | null,
): head is MutableBodyHead & { state: "open" | "sealing" } {
  return head?.state === "open" || head?.state === "sealing";
}

function validateReadyHead(expected: BodyHead, actual: BodyHead): void {
  if (
    actual.bodyId !== expected.bodyId ||
    actual.byteLength !== expected.byteLength ||
    actual.mediaType !== expected.mediaType ||
    actual.digest !== expected.digest
  ) {
    throw conflict(
      `Ready body '${expected.bodyId}' conflicts with staged canonical bytes.`,
    );
  }
}

function validatePutHead(expected: PutBodyInput, actual: BodyHead): void {
  if (
    actual.bodyId !== expected.bodyId ||
    actual.byteLength !== expected.bytes.byteLength ||
    actual.mediaType !== expected.mediaType ||
    actual.digest !== expected.digest
  ) {
    throw conflict(
      `Ready body '${expected.bodyId}' conflicts with canonical bytes.`,
    );
  }
}

function validateSealHead(input: SealBodyInput, head: BodyHead): void {
  if (
    head.bodyId !== input.writer.bodyId ||
    head.mediaType !== input.writer.mediaType ||
    (input.expectedByteLength !== undefined &&
      head.byteLength !== input.expectedByteLength) ||
    (input.expectedDigest !== undefined && head.digest !== input.expectedDigest)
  ) {
    throw conflict(
      `Staged body '${input.writer.bodyId}' conflicts with seal expectations.`,
    );
  }
}

function requireReadyHead(
  bodyId: string,
  head: BodyHead | MutableBodyHead | null,
): BodyHead | null {
  if (!head) return null;
  if (!isReady(head)) {
    throw conflict(
      `Ready backend contains a non-ready body for '${bodyId}'.`,
    );
  }
  return head;
}

function compareBodyId(
  left: BodyHead | MutableBodyHead,
  right: BodyHead | MutableBodyHead,
): number {
  return left.bodyId.localeCompare(right.bodyId);
}

/**
 * Keeps low-latency progressive writes in durable staging while publishing the
 * immutable Ready body to the canonical object backend.
 *
 * Promotion is deliberately recoverable rather than transactional across the
 * two stores. A staged Ready row is the durable promotion intent. It is only
 * CAS-deleted after an exact Ready object has been observed.
 */
export function createPromotedBodyStore(
  options: PromotedBodyStoreOptions,
): BodyStore {
  const staging = options.staging;
  const ready = options.ready;
  if (staging === ready) {
    throw new TypeError("Promoted BodyStore requires distinct stores.");
  }
  const promotions = new Map<string, Promise<BodyHead>>();

  const cleanupStagedReady = async (head: BodyHead): Promise<boolean> => {
    try {
      return await staging.maintenance.delete({
        bodyId: head.bodyId,
        expectedState: "ready",
        expectedMaintenanceVersion: head.maintenanceVersion,
        idleForMs: 0,
      });
    } catch {
      // Ready is already durable. Exact-CAS cleanup is opportunistic and a
      // surviving staged Ready row is the recovery intent for a later pass.
      return false;
    }
  };

  const promoteOnce = async (staged: BodyHead): Promise<BodyHead> => {
    const existing = requireReadyHead(
      staged.bodyId,
      await ready.head({ bodyId: staged.bodyId }),
    );
    if (existing) {
      validateReadyHead(staged, existing);
      await cleanupStagedReady(staged);
      return existing;
    }

    let bytes: Uint8Array;
    try {
      // This is the single staging read on the normal promotion path.
      bytes = await readBodyBytes(staging, { bodyId: staged.bodyId });
    } catch (error) {
      // A competing promoter may have published and cleaned staging between
      // our head and read. Accept only the exact canonical winner.
      const winner = requireReadyHead(
        staged.bodyId,
        await ready.head({ bodyId: staged.bodyId }),
      );
      if (!winner) throw error;
      validateReadyHead(staged, winner);
      return winner;
    }
    const digest = await digestContent(bytes);
    if (bytes.byteLength !== staged.byteLength || digest !== staged.digest) {
      throw createContentError(
        "asset_corrupted",
        `Staged body '${staged.bodyId}' failed promotion verification.`,
      );
    }

    let published: BodyHead;
    try {
      published = await ready.put({
        bodyId: staged.bodyId,
        bytes,
        mediaType: staged.mediaType,
        digest: staged.digest,
        ifAbsent: true,
        ...(staged.protectedUntil
          ? { protectedUntil: staged.protectedUntil }
          : {}),
      });
    } catch (error) {
      // A timeout may be observed after the conditional put committed. Read
      // the winner before deciding whether the promotion actually failed.
      const winner = requireReadyHead(
        staged.bodyId,
        await ready.head({ bodyId: staged.bodyId }),
      );
      if (!winner) throw error;
      validateReadyHead(staged, winner);
      published = winner;
    }
    validateReadyHead(staged, published);
    await cleanupStagedReady(staged);
    return published;
  };

  const promote = (staged: BodyHead): Promise<BodyHead> => {
    const current = promotions.get(staged.bodyId);
    if (current) {
      return current.then((head) => {
        validateReadyHead(staged, head);
        return head;
      });
    }
    const pending = promoteOnce(staged);
    promotions.set(staged.bodyId, pending);
    void pending.finally(() => {
      if (promotions.get(staged.bodyId) === pending) {
        promotions.delete(staged.bodyId);
      }
    }).catch(() => undefined);
    return pending;
  };

  const select = async (
    bodyId: string,
  ): Promise<
    Readonly<{
      store: BodyStore;
      head: BodyHead | MutableBodyHead | null;
    }>
  > => {
    const staged = await staging.head({ bodyId });
    if (isActive(staged)) {
      return Object.freeze({ store: staging, head: staged });
    }
    if (isReady(staged)) {
      return Object.freeze({ store: ready, head: await promote(staged) });
    }
    const canonical = requireReadyHead(
      bodyId,
      await ready.head({ bodyId }),
    );
    if (canonical) {
      // Preserve active-staging precedence across the cross-store lookup race.
      const latest = await staging.head({ bodyId });
      if (isActive(latest)) {
        return Object.freeze({ store: staging, head: latest });
      }
      if (isReady(latest)) {
        return Object.freeze({ store: ready, head: await promote(latest) });
      }
      return Object.freeze({ store: ready, head: canonical });
    }
    return Object.freeze({ store: staging, head: staged });
  };

  const recoverReadyPage = async (
    input: BodyMaintenanceListInput,
  ): Promise<string | undefined> => {
    const page = await staging.maintenance.list({
      ...input,
      states: ["ready"],
    });
    for (const head of page.bodies) {
      if (isReady(head)) await promote(head);
    }
    return page.after;
  };

  const store: BodyStore = {
    kind: ready.kind,
    // Persisted Body locations resolve through the canonical Ready backend.
    backendId: ready.backendId,
    async put(input) {
      const staged = await staging.head({ bodyId: input.bodyId });
      if (isActive(staged)) {
        throw conflict(
          `Progressive body '${input.bodyId}' is still active in staging.`,
        );
      }
      if (isReady(staged)) await promote(staged);
      const head = await ready.put(input);
      validatePutHead(input, head);
      return head;
    },
    async head({ bodyId }) {
      return (await select(bodyId)).head;
    },
    async read({ bodyId }) {
      const selected = await select(bodyId);
      return await selected.store.read({ bodyId });
    },
    async readRange(input) {
      const selected = await select(input.bodyId);
      return await readBodyRange(selected.store, input);
    },
    async follow(input) {
      const selected = await select(input.bodyId);
      return await selected.store.follow(input);
    },
    async reserve(input) {
      const staged = await staging.head({ bodyId: input.bodyId });
      if (isReady(staged)) {
        await promote(staged);
        throw conflict(`Ready body '${input.bodyId}' already exists.`);
      }
      const canonical = requireReadyHead(
        input.bodyId,
        await ready.head({ bodyId: input.bodyId }),
      );
      if (canonical) {
        throw conflict(`Ready body '${input.bodyId}' already exists.`);
      }
      const writer = await staging.reserve(input);
      const raced = requireReadyHead(
        input.bodyId,
        await ready.head({ bodyId: input.bodyId }),
      );
      if (raced) {
        await staging.abort({ writer }).catch(() => undefined);
        throw conflict(
          `Ready body '${input.bodyId}' raced with progressive reservation.`,
        );
      }
      return writer;
    },
    append(input) {
      return staging.append(input);
    },
    async seal(input) {
      const before = await staging.head({ bodyId: input.writer.bodyId });
      if (isReady(before)) {
        validateSealHead(input, before);
        return await promote(before);
      }
      let sealed: BodyHead;
      try {
        sealed = await staging.seal(input);
      } catch (error) {
        // Retrying after a crash/competing seal resumes from durable staged
        // Ready state even though the writer capability has been consumed.
        const recovered = await staging.head({ bodyId: input.writer.bodyId });
        if (!isReady(recovered)) throw error;
        validateSealHead(input, recovered);
        sealed = recovered;
      }
      validateSealHead(input, sealed);
      return await promote(sealed);
    },
    abort(input) {
      return staging.abort(input);
    },
    maintenance: {
      async list(input) {
        const recoveryAfter = await recoverReadyPage(input);
        const stagingStates = input.states.filter((state) => state !== "ready");
        const stagedPage = stagingStates.length
          ? await staging.maintenance.list({ ...input, states: stagingStates })
          : { bodies: [] as readonly (BodyHead | MutableBodyHead)[] };
        const readyPage = input.states.includes("ready")
          ? await ready.maintenance.list({ ...input, states: ["ready"] })
          : { bodies: [] as readonly (BodyHead | MutableBodyHead)[] };

        // If an impossible active/final overlap exists, active staging wins in
        // maintenance just as it does in reads. Final GC must not race a writer.
        const merged = new Map<string, BodyHead | MutableBodyHead>();
        for (const head of readyPage.bodies) merged.set(head.bodyId, head);
        for (const head of stagedPage.bodies) merged.set(head.bodyId, head);
        const bodies = [...merged.values()].sort(compareBodyId).slice(
          0,
          input.limit,
        );
        const sourceAfter = [
          stagedPage.after,
          readyPage.after,
          recoveryAfter,
        ].filter((value): value is string => Boolean(value)).sort()[0];
        const after = bodies.length === input.limit
          ? bodies.at(-1)?.bodyId
          : sourceAfter;
        return Object.freeze({
          bodies: Object.freeze(bodies),
          ...(after ? { after } : {}),
        });
      },
      async delete(input) {
        if (input.expectedState !== "ready") {
          return await staging.maintenance.delete(input);
        }
        const staged = await staging.head({ bodyId: input.bodyId });
        if (isActive(staged)) return false;
        if (isReady(staged)) {
          await promote(staged);
          // Refuse canonical GC while promotion intent still survives. This
          // prevents a delayed staged row from resurrecting a collected body.
          if (isReady(await staging.head({ bodyId: input.bodyId }))) {
            return false;
          }
        }
        return await ready.maintenance.delete(input);
      },
    },
  };
  return Object.freeze(store);
}

function requireClusterDurable(
  name: string,
  adapter: BodyStoreAdapter,
): void {
  if (
    adapter.deployment.durability !== "durable" ||
    adapter.deployment.reach !== "cluster"
  ) {
    throw new TypeError(
      `Promoted BodyStore ${name} must be durable and cluster-reachable.`,
    );
  }
}

function scopeKey(scope: TrustedBodyScope): string {
  return JSON.stringify([scope.databaseSchema, scope.namespace]);
}

/** Creates one cached tiered store per trusted database/namespace scope. */
export function createPromotedBodyStoreAdapter(
  options: PromotedBodyStoreAdapterOptions,
): BodyStoreAdapter {
  requireClusterDurable("staging", options.staging);
  requireClusterDurable("Ready", options.ready);
  const stores = new Map<string, BodyStore>();
  const storeFor = (scope: TrustedBodyScope): BodyStore => {
    const key = scopeKey(scope);
    const existing = stores.get(key);
    if (existing) return existing;
    const created = createPromotedBodyStore({
      staging: options.staging.forScope(scope),
      ready: options.ready.forScope(scope),
    });
    stores.set(key, created);
    return created;
  };
  return Object.freeze({
    deployment: Object.freeze({
      durability: "durable" as const,
      reach: "cluster" as const,
      minimumProtectionMs: options.ready.deployment.minimumProtectionMs,
      readyGarbageCollection: options.ready.deployment.readyGarbageCollection,
    }),
    forScope(scope) {
      return storeFor(scope);
    },
    maintenanceForScope(scope) {
      return storeFor(scope).maintenance;
    },
  });
}
