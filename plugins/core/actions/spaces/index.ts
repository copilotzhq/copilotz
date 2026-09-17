/** Core Space lifecycle and attachment API. Applications authorize each operation. @module */
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type {
  CollectionRecord,
  CollectionTransactionCollections,
  CollectionTransactionRelations,
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import { spaceAttachmentId } from "../../collections/space-attachment/index.ts";

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

export type SpaceAttachmentTransaction = Readonly<{
  collections: CollectionTransactionCollections;
  relations: CollectionTransactionRelations;
}>;

/**
 * Attaches a registered collection record to a Space using Core's canonical
 * attachment and relation semantics. Reads come from the surrounding Action
 * context while writes are staged in the caller's existing transaction.
 */
export async function attachSpaceRecord(
  context: Readonly<{ collections: ScopedCollections }>,
  transaction: SpaceAttachmentTransaction,
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
  const type = target.definition.name;
  const id = spaceAttachmentId(type, recordId);
  await transaction.collections.space.commands.touch({
    id: spaceId,
    active: true,
  });
  const current = await context.collections.spaceAttachment.get({ id });
  if (!await target.get({ id: recordId })) {
    throw new Error("Attachment target does not exist.");
  }
  if (current?.spaceId === spaceId) {
    return { collection: type, recordId };
  }
  const movedFrom = current ? String(current.spaceId) : undefined;
  if (current) {
    if (!movedFrom) throw new Error("Space attachment is invalid.");
    // Both sides participate in the same optimistic transaction.
    await transaction.collections.space.commands.touch({ id: movedFrom });
    await transaction.collections.spaceAttachment.update({
      id,
      set: { spaceId },
    });
  } else {
    await transaction.collections.spaceAttachment.create({
      id,
      collection: type,
      recordId,
      spaceId,
    });
  }
  await transaction.relations.upsert({
    type: "attached_record",
    source: { type: "spaceAttachment", id },
    target: { type, id: recordId },
  });
  return { collection: type, recordId, ...(movedFrom ? { movedFrom } : {}) };
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
              // Store the canonical collection name, so two aliases cannot create two attachments.
              const type = target.definition.name;
              const id = spaceAttachmentId(type, recordId);
              const current = await collections.spaceAttachment.get({ id });
              if (operation === "detach") {
                if (current?.spaceId === spaceId) {
                  await tx.collections.spaceAttachment.delete({ id });
                }
                break;
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
              const attachments: CollectionRecord[] = [];
              let after: string | undefined;
              while (true) {
                const page = await collections.spaceAttachment.list({
                  where: { spaceId },
                  order: { field: "id" },
                  after,
                  limit: 200,
                });
                attachments.push(...page);
                if (page.length < 200) break;
                after = page[page.length - 1].id;
              }
              if (input.requireEmpty && attachments.length > 0) {
                throw new Error(
                  "Space cannot be removed while it has attachments.",
                );
              }
              for (const attachment of attachments) {
                await tx.collections.spaceAttachment.delete({
                  id: attachment.id,
                });
              }
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
