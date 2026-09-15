/** Core Space lifecycle and attachment API. Applications authorize each operation. @module */
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import { spaceAttachmentId } from "../../collections/space-attachment/index.ts";

export const SPACES_ACTION_ID = "copilotz.core.spaces";

export type SpaceInput = {
  operation:
    | "create"
    | "addMember"
    | "removeMember"
    | "attach"
    | "detach"
    | "archive"
    | "restore"
    | "remove";
  spaceId: string;
  name?: string;
  ownerId?: string;
  participantId?: string;
  collection?: string;
  recordId?: string;
};

export type SpaceResult = Pick<SpaceInput, "spaceId" | "operation">;

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
              "archive",
              "restore",
              "remove",
            ],
          },
          spaceId: { type: "string", minLength: 1 },
          name: { type: "string" },
          ownerId: { type: "string", minLength: 1 },
          participantId: { type: "string", minLength: 1 },
          collection: { type: "string", minLength: 1 },
          recordId: { type: "string", minLength: 1 },
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
          await collections.space.create({
            id: spaceId,
            name: input.name ?? "",
            ownerId: input.ownerId,
            memberIds: [input.ownerId],
          });
          return { spaceId, operation };
        }
        await context.transaction(async (tx) => {
          await tx.collections.space.commands.touch({
            id: spaceId,
            active: operation === "attach",
          });
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
              if (!await target.get({ id: recordId })) {
                throw new Error("Attachment target does not exist.");
              }
              if (current?.spaceId === spaceId) break;
              if (current) {
                // Both sides participate in the same optimistic transaction.
                await tx.collections.space.commands.touch({
                  id: String(current.spaceId),
                });
                await tx.collections.spaceAttachment.update({
                  id,
                  set: { spaceId },
                });
              } else {
                await tx.collections.spaceAttachment.create({
                  id,
                  collection: type,
                  recordId,
                  spaceId,
                });
              }
              await tx.relations.upsert({
                type: "attached_record",
                source: { type: "spaceAttachment", id },
                target: { type, id: recordId },
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
              let after: string | undefined;
              while (true) {
                const page = await collections.spaceAttachment.list({
                  where: { spaceId },
                  order: { field: "id" },
                  after,
                  limit: 200,
                });
                for (const attachment of page) {
                  await tx.collections.spaceAttachment.delete({
                    id: attachment.id,
                  });
                }
                if (page.length < 200) break;
                after = page[page.length - 1].id;
              }
              await tx.collections.space.delete({ id: spaceId });
              break;
            }
          }
        });
        return { spaceId, operation };
      },
    },
  );
