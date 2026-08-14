import type { JsonSchema } from "../../dependencies/ominipg.ts";
import type {
  CollectionMutationIdentityFactory,
  CollectionRecord,
  CreateEventCollectionsOptions,
  ErasedEventCollectionRepository,
  EventCollections,
  EventCollectionsScope,
  ScopedCollectionMutationOptions,
  ScopedEventCollection,
} from "./collection-types.ts";
import { createEventCollectionRepository } from "./collections.ts";
import type { MutationIdentity } from "./types.ts";
import type { CollectionDefinition } from "./definition.ts";

type ErasedDefinition = CollectionDefinition<JsonSchema, object, object>;

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function mutationIdentity(
  collection: string,
  operation: "create" | "update" | "delete" | `command:${string}`,
  recordId: string | undefined,
  options: ScopedCollectionMutationOptions | undefined,
  createIdentity: CollectionMutationIdentityFactory | undefined,
): MutationIdentity | undefined {
  if (options?.identity) return options.identity;
  if (!createIdentity) return undefined;
  const explicitKey = options?.operationKey?.trim();
  const operationKey = explicitKey ||
    (recordId ? `${collection}.${operation}:${recordId}` : undefined);
  if (!operationKey) {
    throw new TypeError(
      `Collection '${collection}' create requires an id or operationKey in a delivery context.`,
    );
  }
  return createIdentity(operationKey, {
    collection,
    operation,
    ...(recordId ? { recordId } : {}),
  });
}

function requiredValue<T>(value: T | undefined, operation: string): T {
  if (value === undefined) {
    throw new Error(`Collection ${operation} committed without a value.`);
  }
  return value;
}

/** Composes plugin collection resources into namespace/delivery-scoped APIs. */
export function createEventCollections(
  options: CreateEventCollectionsOptions,
): EventCollections {
  const repositories = new Map<string, ErasedEventCollectionRepository>();
  for (const resource of options.registry.list("collections")) {
    const definition = resource as ErasedDefinition;
    const repository = createEventCollectionRepository({
      definition,
      coordinator: options.coordinator,
      session: options.session,
      eventStore: options.eventStore,
      assets: options.assets,
      validate: options.validate,
      createId: options.createId,
      now: options.now,
    });
    repositories.set(
      definition.name,
      repository as unknown as ErasedEventCollectionRepository,
    );
  }
  const names = Object.freeze([...repositories.keys()]);

  const get = (nameInput: string): ErasedEventCollectionRepository => {
    const name = requireText(nameInput, "Collection name");
    const repository = repositories.get(name);
    if (!repository) throw new Error(`Unknown collection '${name}'.`);
    return repository;
  };

  const withScope = (
    scopeInput: EventCollectionsScope,
  ): Readonly<Record<string, ScopedEventCollection>> => {
    const namespace = requireText(scopeInput.namespace, "Namespace");
    const scoped: Record<string, ScopedEventCollection> = {};
    for (const name of names) {
      const repository = get(name);
      const binding: ScopedEventCollection = Object.freeze({
        definition: repository.definition,
        async create(input, mutationOptions) {
          const rawId = input.id;
          const id = typeof rawId === "string" && rawId.trim()
            ? rawId.trim()
            : undefined;
          const result = await repository.create(input, {
            namespace,
            identity: mutationIdentity(
              name,
              "create",
              id,
              mutationOptions,
              scopeInput.createMutationIdentity,
            ),
          });
          return requiredValue(
            result.value,
            `${name}.create`,
          ) as CollectionRecord;
        },
        async update(idInput, patch, mutationOptions) {
          const id = requireText(idInput, `${name} ID`);
          const result = await repository.update(id, patch, {
            namespace,
            identity: mutationIdentity(
              name,
              "update",
              id,
              mutationOptions,
              scopeInput.createMutationIdentity,
            ),
          });
          return requiredValue(
            result.value,
            `${name}.update`,
          ) as CollectionRecord;
        },
        async delete(idInput, mutationOptions) {
          const id = requireText(idInput, `${name} ID`);
          const result = await repository.delete(id, {
            namespace,
            identity: mutationIdentity(
              name,
              "delete",
              id,
              mutationOptions,
              scopeInput.createMutationIdentity,
            ),
          });
          return requiredValue(result.value, `${name}.delete`);
        },
        async command(idInput, commandInput, input, mutationOptions) {
          const id = requireText(idInput, `${name} ID`);
          const command = requireText(commandInput, `${name} command`);
          const result = await repository.command(id, command, input, {
            namespace,
            identity: mutationIdentity(
              name,
              `command:${command}`,
              id,
              mutationOptions,
              scopeInput.createMutationIdentity,
            ),
          });
          return requiredValue(result.value, `${name}.${command}`);
        },
        get(id) {
          return repository.get(namespace, id);
        },
        list(listOptions) {
          return repository.list(namespace, listOptions);
        },
      });
      scoped[name] = binding;
    }
    return Object.freeze(scoped);
  };

  return Object.freeze({ names, get, withScope });
}
