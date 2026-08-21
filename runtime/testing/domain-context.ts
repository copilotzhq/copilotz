import type {
  AssetOrigin,
  ContentSequence,
  DurableContentInput,
} from "../content/index.ts";
import type { CopilotzEngine } from "../engine/index.ts";
import type { CollectionRecord } from "../collections/index.ts";
import { activeCollectionTransaction } from "../collections/index.ts";
import { createCoreTableNames } from "../events/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
} from "../domain/index.ts";
import {
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
} from "../engine/collection-graph.ts";
import {
  type AnyFeatureDefinition,
  createFeatureContext,
  type FeatureContext,
} from "../features/index.ts";

export type TestDomainHost = Pick<
  CopilotzEngine,
  | "plugins"
  | "databaseSchema"
  | "collections"
  | "collectionRuntime"
  | "content"
  | "events"
  | "deliveries"
  | "relations"
>;

async function materialize(
  host: TestDomainHost,
  namespace: string,
  input: DurableContentInput,
  origin?: AssetOrigin,
): Promise<ContentSequence> {
  const transaction = activeCollectionTransaction(host.collectionRuntime);
  if (!transaction) {
    throw new Error("Test feature content requires an active transaction.");
  }
  return await host.content.assets.materialize({
    transaction,
    tables: createCoreTableNames(host.databaseSchema),
  }, { namespace, content: input, origin });
}

/** Builds the real namespace-scoped domain context for tests. */
export function createTestDomainContext(
  host: TestDomainHost,
  namespace: string,
  featureAliases: Readonly<Record<string, AnyFeatureDefinition>> = {},
  options: Readonly<{ now?: () => Date }> = {},
): FeatureContext {
  return createFeatureContext({
    namespace,
    plugins: host.plugins,
    collections: host.collections,
    collectionRuntime: host.collectionRuntime,
    featureAliases,
    now: options.now,
    contentResolver: host.content.resolver,
    content: (scopedNamespace) =>
      Object.freeze({
        resolver: host.content.resolver,
        materialize: (input, options) =>
          materialize(host, scopedNamespace, input, options?.origin),
        async linkOwner(ownerId, content) {
          const transaction = activeCollectionTransaction(
            host.collectionRuntime,
          );
          if (!transaction) {
            throw new Error(
              "Test feature content requires an active transaction.",
            );
          }
          await host.content.assets.linkOwner({
            transaction,
            tables: createCoreTableNames(host.databaseSchema),
          }, { namespace: scopedNamespace, ownerId, content });
        },
      }),
    events: host.events,
    deliveries: host.deliveries,
    relations: host.relations,
  });
}

export async function projectTestThread(
  context: FeatureContext,
  record: CollectionRecord | null,
): Promise<ConversationThread | null> {
  if (!record) return null;
  const ids = Array.isArray(record.participantIds)
    ? record.participantIds.filter((id): id is string => typeof id === "string")
    : [];
  const participants = await Promise.all(
    ids.map((id) => context.collections.participant.get({ id })),
  );
  return mapThreadRecord(
    record,
    participants.filter((item): item is CollectionRecord => item !== null).map(
      mapParticipantRecord,
    ),
  );
}

export async function projectTestMessage(
  context: FeatureContext,
  record: CollectionRecord | null,
): Promise<ConversationMessage | null> {
  if (!record) return null;
  const sender = await context.collections.participant.get({
    id: String(record.senderId ?? ""),
  });
  if (!sender) throw new Error(`Message '${record.id}' sender was not found.`);
  return mapMessageRecord(record, mapParticipantRecord(sender));
}

export async function projectTestMessages(
  context: FeatureContext,
  records: readonly CollectionRecord[],
): Promise<readonly ConversationMessage[]> {
  return Object.freeze(
    (await Promise.all(
      records.map((record) => projectTestMessage(context, record)),
    ))
      .filter((message): message is ConversationMessage => message !== null),
  );
}
