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
  type ActionEventData,
  type ActionHostContext,
  createActionContext,
} from "../actions/index.ts";

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
  | "bindTransient"
>;

async function materialize(
  host: TestDomainHost,
  namespace: string,
  input: DurableContentInput,
  origin?: AssetOrigin,
): Promise<ContentSequence> {
  const transaction = activeCollectionTransaction(host.collectionRuntime);
  if (!transaction) {
    throw new Error("Test Action content requires an active transaction.");
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
  options: Readonly<{ now?: () => Date }> = {},
): ActionHostContext {
  const lifecycle = new Map<string, ActionEventData>();
  return createActionContext({
    namespace,
    plugins: host.plugins,
    collections: host.collections,
    collectionRuntime: host.collectionRuntime,
    now: options.now,
    contentResolver: host.content.resolver,
    content: (scopedNamespace) =>
      Object.freeze({
        resolver: host.content.resolver,
        prepare: (input, prepareOptions) =>
          host.content.preparer.prepare(input, {
            namespace: scopedNamespace,
            idempotencyKey:
              `test-action:${scopedNamespace}:${prepareOptions.operationKey}`,
            origin: prepareOptions.origin,
          }),
        materialize: (input, options) =>
          materialize(host, scopedNamespace, input, options?.origin),
        async linkOwner(ownerId, content) {
          const transaction = activeCollectionTransaction(
            host.collectionRuntime,
          );
          if (!transaction) {
            throw new Error(
              "Test Action content requires an active transaction.",
            );
          }
          await host.content.assets.linkOwner({
            transaction,
            tables: createCoreTableNames(host.databaseSchema),
          }, { namespace: scopedNamespace, ownerId, content });
        },
        publish: (input, publishOptions) =>
          host.content.assets.publish({
            ...input,
            namespace: scopedNamespace,
            idempotencyKey:
              `test-action:${scopedNamespace}:${publishOptions.operationKey}`,
          }),
        get: (assetId) => host.content.assets.get(scopedNamespace, assetId),
        getMany: (assetIds) =>
          host.content.assets.getMany(scopedNamespace, assetIds),
        resolve: (ref) =>
          host.content.resolver.get(ref, { namespace: scopedNamespace }),
        resolveMany: (refs) =>
          host.content.resolver.getMany(refs, { namespace: scopedNamespace }),
        open: (ref) =>
          host.content.resolver.open(ref, { namespace: scopedNamespace }),
      }),
    actionLifecycle: {
      async append({ draft, data }) {
        const id = draft.deduplicationId?.trim();
        if (!id) {
          throw new TypeError(
            "Test Action lifecycle requires deduplicationId.",
          );
        }
        const existing = lifecycle.get(id);
        if (existing && JSON.stringify(existing) !== JSON.stringify(data)) {
          throw new Error(
            `Test Action lifecycle '${id}' changed across retry.`,
          );
        }
        lifecycle.set(id, structuredClone(data));
        return undefined as never;
      },
      load(_namespace, id) {
        return Promise.resolve(lifecycle.get(id) ?? null);
      },
    },
    events: host.events,
    deliveries: host.deliveries,
    relations: host.relations,
  });
}

export async function projectTestThread(
  context: ActionHostContext,
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
  context: ActionHostContext,
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
  context: ActionHostContext,
  records: readonly CollectionRecord[],
): Promise<readonly ConversationMessage[]> {
  return Object.freeze(
    (await Promise.all(
      records.map((record) => projectTestMessage(context, record)),
    ))
      .filter((message): message is ConversationMessage => message !== null),
  );
}
