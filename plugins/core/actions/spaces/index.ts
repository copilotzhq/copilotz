/** Core Space lifecycle API. Applications authorize each operation. @module */
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  CollectionRecord,
  CollectionTransactionCollections,
  ScopedCollections,
} from "@copilotz/copilotz/collections";

export const SPACES_ACTION_ID = "copilotz.core.spaces";

export type SpaceInput = {
  operation:
    | "create"
    | "addMember"
    | "removeMember"
    | "attach"
    | "detach"
    | "update"
    | "archive"
    | "restore"
    | "remove";
  spaceId: string;
  name?: string;
  description?: string;
  ownerId?: string;
  participantId?: string;
  collection?: string;
  recordId?: string;
  requireEmpty?: boolean;
};

export type SpaceResult = Pick<SpaceInput, "spaceId" | "operation"> & {
  space?: CollectionRecord;
};

function nonEmptyText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string.`);
  }
  return value.trim();
}

export type SpaceTransaction = Readonly<{
  collections: CollectionTransactionCollections;
}>;

/**
 * Attaches a registered collection record through the relationship declared by
 * that resource's own schema. Reads come from the surrounding Action context
 * while writes are staged in the caller's existing transaction.
 */
export async function attachSpaceRecord(
  context: Readonly<{ collections: ScopedCollections }>,
  transaction: SpaceTransaction,
  spaceId: string,
  collection: string,
  recordId: string,
): Promise<
  Readonly<{ collection: string; recordId: string; movedFrom?: string }>
> {
  const target = context.collections[collection];
  if (!target || !recordId) {
    throw new Error(
      "A registered collection alias and recordId are required.",
    );
  }
  requireSpaceRelation(target);
  const mutations = transaction.collections[collection];
  if (!mutations) {
    throw new Error(
      `Collection '${collection}' is unavailable in this transaction.`,
    );
  }
  const type = target.definition.name;
  const record = await target.get({ id: recordId });
  if (!record) throw new Error("Space resource does not exist.");
  const currentSpaceId = typeof record.spaceId === "string"
    ? record.spaceId.trim()
    : "";
  await transaction.collections.space.commands.touch({
    id: spaceId,
    active: true,
  });
  if (currentSpaceId === spaceId) {
    return { collection: type, recordId };
  }
  const movedFrom = currentSpaceId || undefined;
  if (movedFrom) {
    // Both sides participate in the same optimistic transaction.
    await transaction.collections.space.commands.touch({ id: movedFrom });
  }
  await mutations.update({
    id: recordId,
    set: { spaceId },
  });
  return { collection: type, recordId, ...(movedFrom ? { movedFrom } : {}) };
}

function isSpaceResource(
  collection: ScopedCollections[string],
): boolean {
  const relation = collection.definition.relations?.space;
  return collection.definition.name !== "spaceAttachment" &&
    relation?.type === "belongsTo" && relation.collection === "space" &&
    relation.foreignKey === "spaceId";
}

function requireSpaceRelation(collection: ScopedCollections[string]): void {
  if (!isSpaceResource(collection)) {
    throw new Error(
      `Collection '${collection.definition.name}' must declare space: relation.belongsTo("space", "spaceId").`,
    );
  }
}

function requiresSpace(collection: ScopedCollections[string]): boolean {
  const schema = collection.definition.schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return false;
  }
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required) && required.includes("spaceId");
}

function spaceResources(
  collections: ScopedCollections,
): readonly (readonly [string, ScopedCollections[string]])[] {
  const resources: [string, ScopedCollections[string]][] = [];
  const seen = new Set<string>();
  for (const [alias, collection] of Object.entries(collections)) {
    if (!isSpaceResource(collection) || seen.has(collection.definition.name)) {
      continue;
    }
    seen.add(collection.definition.name);
    resources.push([alias, collection]);
  }
  return resources;
}

async function hasSpaceResource(
  resources: readonly (readonly [string, ScopedCollections[string]])[],
  spaceId: string,
): Promise<boolean> {
  for (const [, collection] of resources) {
    if ((await collection.list({ where: { spaceId }, limit: 1 })).length) {
      return true;
    }
  }
  return false;
}

async function clearSpaceResources(
  resources: readonly (readonly [string, ScopedCollections[string]])[],
  transaction: SpaceTransaction,
  spaceId: string,
): Promise<void> {
  for (const [alias, collection] of resources) {
    const mutations = transaction.collections[alias];
    if (!mutations) {
      throw new Error(
        `Collection '${alias}' is unavailable in this transaction.`,
      );
    }
    let after: string | undefined;
    do {
      const records = await collection.list({
        where: { spaceId },
        order: { field: "id" },
        after,
        limit: 200,
      });
      if (records.length && requiresSpace(collection)) {
        throw new Error(
          `Space cannot be removed while required resource '${
            records[0].id
          }' is attached.`,
        );
      }
      for (const record of records) {
        await mutations.update({ id: record.id, unset: ["spaceId"] });
      }
      after = records.length === 200
        ? records[records.length - 1].id
        : undefined;
    } while (after);
  }
}

export const spacesAction: ActionDefinition<SpaceInput, SpaceResult> =
  defineAction(
    {
      id: SPACES_ACTION_ID,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          operation: {
            enum: [
              "create",
              "addMember",
              "removeMember",
              "attach",
              "detach",
              "update",
              "archive",
              "restore",
              "remove",
            ],
          },
          spaceId: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          description: { type: "string" },
          ownerId: { type: "string", minLength: 1 },
          participantId: { type: "string", minLength: 1 },
          collection: { type: "string", minLength: 1 },
          recordId: { type: "string", minLength: 1 },
          requireEmpty: { type: "boolean" },
        },
        required: ["operation", "spaceId"],
      } as const,
      async execute(input: SpaceInput, context) {
        const { operation, spaceId } = input;
        const collections = context.collections;
        if (operation === "create") {
          if (
            !input.ownerId ||
            !await collections.participant.get({ id: input.ownerId })
          ) {
            throw new Error("An existing owner Participant is required.");
          }
          const description = input.description === undefined
            ? undefined
            : optionalText(input.description, "Space description");
          await collections.space.create({
            id: spaceId,
            name: input.name ?? "",
            ownerId: input.ownerId,
            memberIds: [input.ownerId],
            ...(description ? { description } : {}),
          });
          return { spaceId, operation };
        }
        await context.transaction(async (tx) => {
          if (operation !== "attach") {
            await tx.collections.space.commands.touch({
              id: spaceId,
              active: operation === "update",
            });
          }
          switch (operation) {
            case "addMember":
            case "removeMember": {
              const participantId = input.participantId;
              if (
                !participantId ||
                !await collections.participant.get({ id: participantId })
              ) {
                throw new Error("An existing member Participant is required.");
              }
              await tx.collections.space.commands.member({
                id: spaceId,
                participantId,
                remove: operation === "removeMember",
              });
              break;
            }
            case "attach":
            case "detach": {
              const { collection, recordId } = input;
              const target = collection && collections[collection];
              if (!target || !recordId) {
                throw new Error(
                  "A registered collection alias and recordId are required.",
                );
              }
              if (operation === "attach") {
                await attachSpaceRecord(
                  { collections },
                  tx,
                  spaceId,
                  collection,
                  recordId,
                );
                break;
              }
              requireSpaceRelation(target);
              const current = await target.get({ id: recordId });
              if (!current) throw new Error("Space resource does not exist.");
              if (current.spaceId === spaceId) {
                if (requiresSpace(target)) {
                  throw new Error(
                    "A required Space relationship cannot be detached.",
                  );
                }
                const mutations = tx.collections[collection];
                if (!mutations) {
                  throw new Error(
                    `Collection '${collection}' is unavailable in this transaction.`,
                  );
                }
                await mutations.update({
                  id: recordId,
                  unset: ["spaceId"],
                });
              }
              break;
            }
            case "update": {
              const current = await collections.space.get({ id: spaceId });
              if (!current) throw new Error("Space was not found.");
              if (input.name === undefined && input.description === undefined) {
                throw new TypeError(
                  "Space update requires a name or description.",
                );
              }
              const set: Record<string, string> = {};
              if (input.name !== undefined) {
                const name = nonEmptyText(input.name, "Space name");
                if (name !== current.name) set.name = name;
              }
              if (input.description !== undefined) {
                const description = optionalText(
                  input.description,
                  "Space description",
                );
                const currentDescription = typeof current.description ===
                    "string"
                  ? current.description
                  : "";
                if (description !== currentDescription) {
                  set.description = description;
                }
              }
              if (Object.keys(set).length === 0) {
                throw new Error("Space update does not change anything.");
              }
              await tx.collections.space.update({
                id: spaceId,
                set,
              });
              break;
            }
            case "archive":
            case "restore":
              await tx.collections.space.update({
                id: spaceId,
                set: {
                  status: operation === "archive" ? "archived" : "active",
                },
              });
              break;
            case "remove": {
              const resources = spaceResources(collections);
              if (
                input.requireEmpty && await hasSpaceResource(resources, spaceId)
              ) {
                throw new Error(
                  "Space cannot be removed while it has resources.",
                );
              }
              await clearSpaceResources(resources, tx, spaceId);
              await tx.collections.space.delete({ id: spaceId });
              break;
            }
          }
        });
        if (operation === "update") {
          const space = await collections.space.get({ id: spaceId });
          if (!space) throw new Error("Updated Space was not found.");
          return { spaceId, operation, space };
        }
        return { spaceId, operation };
      },
    },
  );

export default spacesAction;
