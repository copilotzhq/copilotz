import { captureOwnerCommandAuthorization } from "../engine/command-authorization.ts";
/** Acceptance-only facade over registered transaction Collection methods. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  CollectionRuntime,
  CollectionTransactionCollections,
} from "../collections/kernel.ts";

import { withOwnerCollectionInvocation } from "../collections/policy-invocation.ts";
import type { CommandContext } from "../engine/commands.ts";
import type { ProtectedActionSourceBinding } from "./protected-action-source.ts";
import type { SqlExecutor } from "../events/session.ts";
import type {
  ProtectedActionCollections,
  ProtectedActionOwnerContext,
  ProtectedActionSource,
} from "./protected-action-types.ts";

export type ProtectedActionCollectionRuntime = Readonly<{
  runtime: CollectionRuntime;
  definitions: Readonly<Record<string, CollectionDefinition>>;
}>;
export function withProtectedActionCollections<T>(
  registered: ProtectedActionCollectionRuntime,
  command: CommandContext,
  owner: Pick<ProtectedActionOwnerContext, "scope" | "action" | "signal"> & {
    source: ProtectedActionSourceBinding;
    resolveSource(transaction: SqlExecutor): Promise<ProtectedActionSource>;
  },
  execute: (collections: CollectionTransactionCollections) => Promise<T>,
): Promise<T> {
  return withOwnerCollectionInvocation({
    ...owner,
    invocation: { kind: "action", ...owner.action },
    check() {
      owner.signal.throwIfAborted();
    },
  }, async () => {
    const result = await registered.runtime.transaction({
      namespace: owner.scope.namespace,
      operationKey: JSON.stringify([
        "action.accept-output",
        owner.action.runId,
      ]),
      identity: {
        actionScopeId: owner.action.runId,
        causationId: owner.source.eventId,
        ...(owner.source.operationId
          ? { settlementScopeId: owner.source.operationId }
          : {}),
      },
      execute: ({ collections }) => execute(collections),
    }, command);
    return result.value;
  });
}
export function protectedActionCollectionFacade(
  definitions: ProtectedActionCollectionRuntime["definitions"],
  collections: CollectionTransactionCollections,
  assertActive: () => void,
  track: <T>(promise: Promise<T>) => Promise<T>,
): ProtectedActionCollections {
  let sequence = 0;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(definitions).map(([alias, definition]) => {
        const collection = collections[definition.name];
        if (!collection) {
          throw new Error("Registered adoption Collection is unavailable.");
        }
        const method = (
          call: (
            input: never,
            options: { operationKey: string },
          ) => Promise<{ id: string }>,
        ) =>
        (input: unknown) => {
          try {
            assertActive();
          } catch (error) {
            return Promise.reject(error);
          }
          try {
            captureOwnerCommandAuthorization();
            const captured = captureHostCommandJson(input);
            const operationKey = JSON.stringify([
              "accept",
              sequence++,
              alias,
            ]);
            return track(call(captured as never, { operationKey }));
          } catch (error) {
            return track(Promise.reject(error));
          }
        };
        return [
          alias,
          Object.freeze({
            create: method(collection.create),
            update: method(collection.update),
            delete: method(collection.delete),
            commands: Object.freeze(
              Object.fromEntries(
                Object.entries(collection.commands).map(
                  ([name, call]) => [name, method(call)],
                ),
              ),
            ),
          }),
        ];
      }),
    ),
  );
}
