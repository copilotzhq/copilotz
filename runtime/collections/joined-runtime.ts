/** Internal registered-kernel binding for one already-active owner command. */
import {
  bindCommandExecutorAlias,
  type CommandContext,
  schemaCommandContext,
} from "../engine/commands.ts";
import { readEventByDeduplicationIdOn } from "../events/store.ts";
import {
  afterSqlCommit,
  type SqlExecutor,
  type SqlSession,
} from "../events/session.ts";
import { readViews } from "./read-view.ts";
import {
  type CollectionRuntime,
  createCollectionRuntime,
  type CreateCollectionRuntimeOptions,
} from "./kernel.ts";
import type { CollectionDefinition } from "./definition.ts";

const sources = new WeakMap<
  CollectionRuntime,
  CreateCollectionRuntimeOptions
>();
const borrowedTransactions = new WeakMap<
  CreateCollectionRuntimeOptions,
  SqlExecutor
>();
const pendingInvalidations = new WeakSet<SqlExecutor>();
export function registerCollectionRuntimeSource(
  runtime: CollectionRuntime,
  options: CreateCollectionRuntimeOptions,
): void {
  sources.set(runtime, options);
}
export function collectionRuntimeCommitPending(
  options: CreateCollectionRuntimeOptions,
): boolean {
  return borrowedTransactions.has(options);
}
export function requiresCapturedCollectionContent(
  options: CreateCollectionRuntimeOptions,
): boolean {
  return borrowedTransactions.has(options);
}

/** Borrowed writes refresh committed hop views only at the outer SQL gate. */
export function invalidateCollectionReadViews(
  options: CreateCollectionRuntimeOptions,
  key?: string,
): void {
  const transaction = borrowedTransactions.get(options);
  if (transaction) {
    if (!pendingInvalidations.has(transaction)) {
      afterSqlCommit(transaction, () => readViews.invalidateAll());
      pendingInvalidations.add(transaction);
    }
  } else if (key === undefined) {
    readViews.invalidateAll();
  } else {
    readViews.invalidate(key);
  }
}

/** Reuses the same kernel; no connection, transaction, publication, or scope is created. */
export function joinCollectionRuntime(
  runtime: CollectionRuntime,
  definitions: Readonly<Record<string, CollectionDefinition>>,
  command: CommandContext,
): Readonly<{ runtime: CollectionRuntime; close(): void }> {
  const source = sources.get(runtime);
  if (!source) {
    throw new TypeError("Registered Collection runtime is unavailable.");
  }
  let active = true;
  const check = () => {
    command.signal.throwIfAborted();
    if (!active) throw new Error("Owner Collection adoption has ended.");
  };
  const session: SqlSession = {
    query(sql, params) {
      check();
      return command.transaction.query(sql, params);
    },
    transaction() {
      throw new Error(
        "Owner Collection adoption cannot acquire a transaction.",
      );
    },
  };
  bindCommandExecutorAlias(session, command.transaction, check);
  const options: CreateCollectionRuntimeOptions = {
    ...source,
    session,
    eventStore: {
      ...source.eventStore,
      session,
      getEventByDeduplicationId(namespace, id) {
        check();
        return readEventByDeduplicationIdOn(
          command.transaction,
          source.eventStore.tables,
          namespace,
          id,
        );
      },
    },
    coordinator: {
      ...source.coordinator,
      commitMutation(input) {
        check();
        return source.coordinator.commitMutation({
          ...input,
          transaction: command.transaction,
          dispatch: false,
        });
      },
    },
    ...(source.assets
      ? {
        assets: {
          ...source.assets,
          prepareMaterialization(input) {
            check();
            return source.assets!.prepareMaterialization(
              input,
              command.transaction,
            );
          },
          publishMaterializations(plans) {
            check();
            command.afterCommit(() =>
              source.assets!.publishMaterializations(plans)
            );
          },
        },
      }
      : {}),
  };
  borrowedTransactions.set(
    options,
    schemaCommandContext(command.transaction, source.eventStore.databaseSchema)
      .transaction,
  );
  const joined = createCollectionRuntime(options);
  for (const definition of Object.values(definitions)) {
    const registered = runtime.get(definition.name);
    if (!registered || registered.definition !== definition) {
      throw new TypeError(
        "Collection adoption requires the registered declaration.",
      );
    }
    joined.bind(definition);
  }
  return Object.freeze({
    runtime: joined,
    close() {
      active = false;
    },
  });
}
