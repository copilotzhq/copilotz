/** Internal registered-kernel binding for one already-active owner command. */
import {
  bindCommandExecutorAlias,
  type CommandContext,
} from "../engine/commands.ts";
import { readEventByDeduplicationIdOn } from "../events/store.ts";
import type { SqlSession } from "../events/session.ts";
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
const capturedContentOnly = new WeakSet<CreateCollectionRuntimeOptions>();
export function registerCollectionRuntimeSource(
  runtime: CollectionRuntime,
  options: CreateCollectionRuntimeOptions,
): void {
  sources.set(runtime, options);
}
export function collectionRuntimeCommitPending(
  options: CreateCollectionRuntimeOptions,
): boolean {
  return capturedContentOnly.has(options);
}
export function requiresCapturedCollectionContent(
  options: CreateCollectionRuntimeOptions,
): boolean {
  return capturedContentOnly.has(options);
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
      flushCommitted(result) {
        check();
        command.afterCommit(async () => {
          await source.coordinator.flushCommitted(result);
        });
        return Promise.resolve({ handles: [], failures: [] });
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
  capturedContentOnly.add(options);
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
