import type {
  AssetOrigin,
  ContentPreparer,
  ContentResolver,
  ContentSequence,
  DatabaseAssetRepository,
  DurableContentInput,
} from "@copilotz/copilotz/content";
import type {
  CollectionRecord,
  CollectionRuntime,
} from "@copilotz/copilotz/collections";
import {
  type ActionEventData,
  type ActionHostContext,
  createActionContext,
} from "@copilotz/copilotz/actions";
import type { PluginRegistry, Processor } from "@copilotz/copilotz/plugins";
import type {
  ConversationMessage,
  ConversationThread,
} from "../../../core-collections/internal/contracts.ts";
import {
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
} from "../../../core-collections/internal/projections.ts";

export type TestDomainHost = Readonly<{
  databaseSchema: string;
  plugins: PluginRegistry;
  collections: CollectionRuntime;
  content: Readonly<{
    assets: Pick<
      DatabaseAssetRepository,
      "get" | "getMany" | "materialize" | "publish"
    >;
    preparer: ContentPreparer;
    resolver: ContentResolver;
  }>;
  bindTransient(
    processor: Processor,
    options?: Readonly<{
      namespace?: string;
      afterPosition?: string;
      signal?: AbortSignal;
    }>,
  ): Promise<() => void>;
}>;

async function materialize(
  host: TestDomainHost,
  namespace: string,
  input: DurableContentInput,
  origin?: AssetOrigin,
): Promise<ContentSequence> {
  return await host.content.assets.materialize({
    namespace,
    content: input,
    origin,
  });
}

/** Builds the real namespace-scoped Core context for tests. */
export function createTestDomainContext(
  host: TestDomainHost,
  namespace: string,
  options: Readonly<{ now?: () => Date }> = {},
): ActionHostContext {
  const lifecycle = new Map<string, ActionEventData>();
  return createActionContext({
    namespace,
    databaseSchema: host.databaseSchema,
    plugins: host.plugins,
    collections: host.collections,
    now: options.now,
    content: (scopedNamespace) =>
      Object.freeze({
        resolver: host.content.resolver,
        stream: Object.freeze({
          open() {
            throw new Error("Test content streams are not configured.");
          },
          follow() {
            throw new Error("Test content streams are not configured.");
          },
        }),
        prepare: (input, prepareOptions) =>
          host.content.preparer.prepare(input, {
            namespace: scopedNamespace,
            idempotencyKey:
              `test-action:${scopedNamespace}:${prepareOptions.operationKey}`,
            origin: prepareOptions.origin,
          }),
        materialize: (input, options) =>
          materialize(host, scopedNamespace, input, options?.origin),
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
      append({ draft, data }) {
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
        return Promise.resolve(undefined as never);
      },
      load(_namespace, id) {
        return Promise.resolve(lifecycle.get(id) ?? null);
      },
    },
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
    )).filter((message): message is ConversationMessage => message !== null),
  );
}
