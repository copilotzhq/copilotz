/**
 * Participant migration: graph nodes (`type = 'user'`) ->
 * `collections.participant`.
 *
 * Import this module from maintenance scripts or one-off Deno tasks.
 *
 * @example
 * ```ts
 * import { migrateLegacyParticipantGraphNodesToCollection } from "@/database/scripts/compat/migrate-legacy-participants.ts";
 * await migrateLegacyParticipantGraphNodesToCollection(
 *   { collections: copilotz.collections, ops: copilotz.ops },
 *   { limit: 50_000 },
 * );
 * ```
 *
 * @module
 */
import type {
  CollectionsManager,
  CopilotzDb,
  ScopedCollectionsManager,
} from "@/types/index.ts";

type CollectionAccessor = CollectionsManager | ScopedCollectionsManager | undefined;

type ScopedCollectionLike<TRecord> = {
  findOne: (
    filter: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<TRecord | null>;
  upsert: (
    filter: Record<string, unknown>,
    data: Record<string, unknown>,
  ) => Promise<TRecord>;
};

interface ParticipantRecord extends Record<string, unknown> {
  id: string;
  namespace?: string;
  externalId: string;
  participantType: "human" | "agent";
  name?: string | null;
  email?: string | null;
  agentId?: string | null;
  metadata?: Record<string, unknown> | null;
  isGlobal?: boolean | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
}

function getScopedCollection<TRecord>(
  collections: CollectionAccessor,
  collectionName: string,
  namespace?: string,
): ScopedCollectionLike<TRecord> | undefined {
  if (!collections) return undefined;
  const maybeManager = collections as CollectionsManager & Record<string, unknown>;
  if (namespace && typeof maybeManager.withNamespace === "function") {
    const scoped = maybeManager.withNamespace(namespace) as Record<string, unknown>;
    return scoped[collectionName] as ScopedCollectionLike<TRecord> | undefined;
  }
  return (collections as Record<string, unknown>)[collectionName] as
    | ScopedCollectionLike<TRecord>
    | undefined;
}

export interface MigrateLegacyParticipantsResult {
  migrated: number;
  skipped: number;
  skippedReasons: {
    noExternalId: number;
    noCollection: number;
    alreadyPresent: number;
  };
}

/**
 * Copy graph-backed participant nodes (`type = 'user'`) into
 * `collections.participant` so reads can use the collection path exclusively
 * after migration.
 *
 * - Idempotent: rows that already exist for the same `externalId` in the target
 *   namespace are skipped unless `overwriteExisting` is true.
 * - Preserves graph node `id` on the collection row so edges that reference the
 *   participant node id remain consistent.
 */
export async function migrateLegacyParticipantGraphNodesToCollection(
  deps: { collections?: CollectionAccessor; ops: CopilotzDb["ops"] },
  options?: {
    namespace?: string;
    limit?: number;
    /** When true, overwrites collection rows from graph data. Default false. */
    overwriteExisting?: boolean;
  },
): Promise<MigrateLegacyParticipantsResult> {
  const { collections, ops } = deps;
  if (!collections) {
    throw new Error(
      "collections is required to migrate legacy participant graph nodes",
    );
  }

  const nodes = await ops.listLegacyParticipantGraphNodes({
    namespace: options?.namespace,
    limit: options?.limit,
  });

  let migrated = 0;
  const skippedReasons = {
    noExternalId: 0,
    noCollection: 0,
    alreadyPresent: 0,
  };

  for (const node of nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>;
    const externalId =
      (typeof data.externalId === "string" && data.externalId.length > 0)
        ? data.externalId
        : typeof node.sourceId === "string" && node.sourceId.length > 0
        ? node.sourceId
        : null;

    if (!externalId) {
      skippedReasons.noExternalId++;
      continue;
    }

    const participantType =
      data.participantType === "agent" || data.participantType === "human"
        ? data.participantType
        : "human";

    const ns = typeof node.namespace === "string" && node.namespace.length > 0
      ? node.namespace
      : "global";

    const scoped = getScopedCollection<ParticipantRecord>(
      collections,
      "participant",
      ns,
    );
    if (!scoped?.upsert) {
      skippedReasons.noCollection++;
      continue;
    }

    const existing = await scoped.findOne({ externalId });
    if (existing && !options?.overwriteExisting) {
      skippedReasons.alreadyPresent++;
      continue;
    }

    await scoped.upsert(
      { externalId },
      {
        id: node.id as string,
        externalId,
        participantType,
        name: (data.name ?? null) as string | null,
        email: (data.email ?? null) as string | null,
        agentId: (data.agentId ?? null) as string | null,
        metadata: (data.metadata ?? null) as Record<string, unknown> | null,
        isGlobal: (data.isGlobal ?? ns === "global") as boolean,
      },
    );
    migrated++;
  }

  const skipped =
    skippedReasons.noExternalId +
    skippedReasons.noCollection +
    skippedReasons.alreadyPresent;

  return { migrated, skipped, skippedReasons };
}
