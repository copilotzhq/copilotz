import { captureHostCommandJson } from "../application/host-command-json.ts";
import { sameValue, stableStringify } from "../collections/equal.ts";
import { loadCollectionRecord } from "../collections/reducer.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { constrainCollection } from "./collection-constraints.ts";
import type { CollectionPolicyIntent } from "./intent.ts";
import { authorizeOwnerCommand } from "../engine/command-authorization.ts";
/** Owner-only bridge to the destination's registered native Collection runtime. */
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  CollectionRuntime,
  TransactionCollection,
} from "../collections/kernel.ts";
import type {
  CollectionMutationRef,
  CollectionRecord,
} from "../collections/types.ts";
import {
  type CommandContext,
  type DatabaseOwner,
  joinDatabaseOwnerCommand,
} from "../engine/commands.ts";
import {
  withoutOwnerCommandAuthorization,
  withOwnerAuthorizationPhase,
} from "../engine/command-authorization.ts";
import {
  authorizationRefused,
  createOwnerEvaluator,
  type OwnerAuthorization,
} from "./evaluator.ts";
import {
  type CollectionInvocationAuthority,
  collectionInvocationOwner,
  withOwnerCollectionInvocation,
} from "./invocation.ts";
import type { IdentityEvidenceReader } from "./identity-evidence.ts";
import type { DatabaseDirectoryCommand } from "./directory-command.ts";

export type DirectoryCollection = Readonly<{
  get(input: Readonly<{ id: string }>): Promise<CollectionRecord | null>;
  create(
    input: Readonly<Record<string, unknown>>,
  ): Promise<CollectionMutationRef>;
  commands: Readonly<
    Record<
      string,
      (
        input: Readonly<Record<string, unknown> & { id: string }>,
      ) => Promise<CollectionMutationRef>
    >
  >;
}>;
export type DirectoryCollections = Readonly<
  Record<string, DirectoryCollection>
>;
type Registration = Readonly<{
  runtime: CollectionRuntime;
  definitions: Readonly<Record<string, CollectionDefinition>>;
  authorization?: OwnerAuthorization;
}>;
const repositories = new WeakMap<DatabaseOwner, Set<Registration>>();
export function registerDirectoryCollections(
  owner: DatabaseOwner,
  registration: Registration,
): () => void {
  let entries = repositories.get(owner);
  if (!entries) repositories.set(owner, entries = new Set());
  entries.add(registration);
  return () => {
    entries.delete(registration);
  };
}

export async function withDirectoryCollections<T>(options: {
  owner: DatabaseOwner;
  source: CommandContext;
  binding: CollectionInvocationAuthority;
  definition: DatabaseDirectoryCommand;
  evidence: IdentityEvidenceReader;
  key: string;
  replay?: readonly CollectionPolicyIntent[];
  execute(collections: DirectoryCollections): Promise<T>;
}): Promise<{ value: T; intents: readonly CollectionPolicyIntent[] }> {
  const { owner, source, definition, evidence, key } = options;
  const candidates = [...repositories.get(owner) ?? []].filter((entry) =>
    Object.keys(definition.collections ?? {}).every((alias) =>
      Object.hasOwn(entry.definitions, alias)
    )
  );
  if (candidates.length !== 1) authorizationRefused();
  const registration = candidates[0];
  if (!registration.authorization) authorizationRefused();
  const selected = Object.entries(definition.collections ?? {}).map(
    ([alias, methods]) => {
      const declared = Object.hasOwn(registration.definitions, alias) &&
        registration.definitions[alias];
      if (
        !declared ||
        !Object.hasOwn(registration.authorization!.collections, alias)
      ) authorizationRefused();
      for (const method of methods) {
        if (
          method !== "get" && method !== "create" &&
          !Object.hasOwn(declared.commands ?? {}, method)
        ) authorizationRefused();
      }
      return { alias, methods, declared };
    },
  );
  const binding = collectionInvocationOwner(options.binding);
  const intents = new Map<string, CollectionPolicyIntent>();
  const evaluate = createOwnerEvaluator({
    registration: registration.authorization,
    collections: registration.definitions,
    databaseSchema: definition.databaseSchema,
    directory: {
      command: definition.command,
      databaseSchema: definition.databaseSchema,
      namespace: definition.namespace,
      evidence,
    },
  });
  return await joinDatabaseOwnerCommand(source, owner, async (command) => {
    const check = () => {
      binding.check();
      owner.signal.throwIfAborted();
    };
    const authorizeIntent = async (
      intent: CollectionPolicyIntent,
      read: Pick<CommandContext, "transaction" | "commandTime">,
    ) => {
      check();
      // Only this declaration's registered alias/method may use the bridge.
      const entry = selected.find((entry) =>
        entry.alias === intent.collection.alias
      );
      const method = intent.method === "command"
        ? (intent.args as { name?: string }).name
        : intent.method;
      if (!entry || !method || !entry.methods.includes(method)) {
        authorizationRefused();
      }
      intents.set(
        stableStringify({
          collection: intent.collection,
          method: intent.method,
          args: intent.args,
          ...(intent.result === undefined ? {} : { result: intent.result }),
          ...(intent.next === undefined ? {} : { next: intent.next }),
        }),
        captureHostCommandJson(intent) as CollectionPolicyIntent,
      );
      return (await evaluate(binding.authority!, {
        kind: "collection",
        resource: entry.alias,
        operation: intent.method,
        input: intent,
        invocation: binding.invocation,
      }, { ...read, signal: owner.signal })).constraints;
    };
    return await withoutOwnerCommandAuthorization(() =>
      withOwnerCollectionInvocation({
        authority: binding.authority,
        invocation: binding.invocation,
        scope: {
          databaseSchema: definition.databaseSchema,
          namespace: definition.namespace,
        },
        signal: owner.signal,
        check,
        resolveSource: binding.resolveSource,
        authorizeDirectoryIntent: authorizeIntent,
      }, async () => {
        if (options.replay) {
          await authorizeOwnerCommand(
            async (read) => {
              for (const retained of options.replay!) {
                const entry = selected.find((entry) =>
                  entry.alias === retained.collection.alias
                );
                if (!entry) authorizationRefused();
                const args = retained.args as {
                  id?: string;
                  input?: { id?: string };
                };
                const id = args.id ?? args.input?.id;
                const current = id
                  ? await loadCollectionRecord(
                    read.transaction,
                    createCoreTableNames(definition.databaseSchema),
                    definition.namespace,
                    entry.declared.name,
                    id,
                  )
                  : null;
                const intent = { ...retained, current };
                const constrained = constrainCollection(
                  intent,
                  await authorizeIntent(intent, read),
                );
                if (
                  !sameValue(constrained, retained.args)
                ) authorizationRefused();
              }
            },
            command,
            "mutation",
          );
          return {
            value: await options.execute(Object.freeze({})),
            intents: options.replay,
          };
        }
        const result = await registration.runtime.transaction({
          namespace: definition.namespace,
          operationKey: key,
          async execute({ collections }) {
            let active = true;
            let refused = false;
            const refuse = (): never => {
              refused = true;
              authorizationRefused();
            };
            const pending: Promise<unknown>[] = [];
            const reads = registration.runtime.withScope({
              namespace: definition.namespace,
            });
            const call = <R>(run: () => Promise<R>): Promise<R> => {
              if (!active) {
                return Promise.reject(
                  new Error("Directory Collection repository lifetime ended."),
                );
              }
              const promise = withoutOwnerCommandAuthorization(run);
              pending.push(promise);
              void promise.catch(() => undefined);
              return promise;
            };
            const repository = Object.freeze(
              Object.fromEntries(
                selected.map(({ alias, methods, declared }) => {
                  const native: TransactionCollection =
                    collections[declared.name];
                  return [
                    alias,
                    Object.freeze({
                      get: (input: { id: string }) =>
                        call(() => {
                          if (
                            !methods.includes("get")
                          ) refuse();
                          return reads[declared.name].get(input);
                        }),
                      create: (input: Record<string, unknown>) =>
                        call(() => {
                          if (!methods.includes("create")) {
                            refuse();
                          }
                          return native.create(input);
                        }),
                      commands: new Proxy(
                        Object.freeze(
                          Object.fromEntries(
                            methods.filter((method) =>
                              method !== "get" && method !== "create"
                            ).map((
                              method,
                            ) => [
                              method,
                              (
                                input: Record<string, unknown> & { id: string },
                              ) => call(() => native.commands[method](input)),
                            ]),
                          ),
                        ),
                        {
                          get(target, key) {
                            if (
                              typeof key === "string" &&
                              !Object.hasOwn(target, key)
                            ) refuse();
                            return Reflect.get(target, key);
                          },
                        },
                      ),
                    }),
                  ];
                }),
              ),
            ) as DirectoryCollections;
            try {
              const result = await withOwnerAuthorizationPhase(() =>
                options.execute(
                  new Proxy(repository, {
                    get(target, key) {
                      if (
                        typeof key === "string" && !Object.hasOwn(target, key)
                      ) refuse();
                      return Reflect.get(target, key);
                    },
                  }),
                )
              );
              active = false;
              await Promise.all(pending);
              if (refused) refuse();
              return result;
            } finally {
              active = false;
              await Promise.allSettled(pending);
            }
          },
        }, command);
        const retained = [...intents.values()];
        if (
          new TextEncoder().encode(stableStringify(retained)).length > 1048576
        ) authorizationRefused();
        return { value: result.value, intents: retained };
      })
    );
  });
}
