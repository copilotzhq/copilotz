/** Bounded public display projection for authorized conversation participants. @module */
import { Ajv } from "../../../../../dependencies/ajv.ts";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { HttpHandlerContext } from "../../../../server/authoring/http-adapter/index.ts";

const identifier = { type: "string", minLength: 1, maxLength: 512 } as const;

/** Input to the trusted, statically configured participant display query. */
export const participantDisplayInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["threadId", "participantIds", "purpose"],
  properties: {
    threadId: identifier,
    participantIds: {
      type: "array",
      maxItems: 4,
      uniqueItems: true,
      items: identifier,
    },
    purpose: { type: "string", enum: ["participants", "senders"] },
  },
} as const;

/** Deliberately excludes email and arbitrary participant metadata. */
export const participantDisplayOutputSchema = {
  type: "array",
  maxItems: 4,
  items: {
    type: "object",
    additionalProperties: false,
    required: [
      "id",
      "namespace",
      "externalId",
      "participantType",
      "metadata",
      "createdAt",
      "updatedAt",
    ],
    properties: {
      id: identifier,
      namespace: identifier,
      externalId: identifier,
      participantType: {
        type: "string",
        enum: ["human", "agent", "tool", "job"],
      },
      name: { type: "string", maxLength: 4096 },
      agentId: identifier,
      metadata: {
        type: "object",
        maxProperties: 0,
        additionalProperties: false,
      },
      createdAt: { type: "string", minLength: 1, maxLength: 64 },
      updatedAt: { type: "string", minLength: 1, maxLength: 64 },
    },
  },
} as const;

// The portable CJS dependency exposes its constructor through the default export.
const Validator = Ajv as unknown as {
  new (): { compile(schema: object): (value: unknown) => boolean };
};
const ajv = new Validator();
const validSelection = ajv.compile({
  ...participantDisplayInputSchema,
  properties: {
    ...participantDisplayInputSchema.properties,
    participantIds: {
      ...participantDisplayInputSchema.properties.participantIds,
      maxItems: 1000,
    },
  },
});
const validOutput = ajv.compile(participantDisplayOutputSchema);

function invalidProjection(): never {
  throw Object.assign(new Error("Participant display projection is invalid."), {
    code: "invalid_projection",
    status: 500,
  });
}

/** The query must itself check current thread/Space policy and exact relationships. */
export async function readParticipantDisplays(
  context: HttpHandlerContext,
  queryName: string,
  thread: CollectionRecord,
  participantIds: readonly string[],
  purpose: "participants" | "senders",
): Promise<readonly CollectionRecord[]> {
  const namespace = thread.namespace;
  const input = { threadId: thread.id, participantIds, purpose };
  if (
    !validSelection(input) || typeof namespace !== "string" ||
    !namespace.length ||
    (context.scope.namespace !== undefined &&
      context.scope.namespace !== namespace)
  ) invalidProjection();
  if (participantIds.length === 0) return [];
  const capturedIds = Object.freeze([...participantIds]);
  const byId = new Map<string, CollectionRecord>();
  // Four 512-character escaped IDs plus the thread ID fit the existing
  // owner-projection 16 KiB/512-node input budget, including JSON escaping.
  // Sequential queries bound in-flight work and each retains current policy checks.
  for (let offset = 0; offset < capturedIds.length; offset += 4) {
    const batch = Object.freeze(capturedIds.slice(offset, offset + 4));
    const rows = await context.read.query(
      "participant",
      queryName,
      Object.freeze({ ...input, participantIds: batch }),
    );
    if (!validOutput(rows) || rows.length !== batch.length) invalidProjection();
    const requested = new Set(batch);
    for (const row of rows) {
      if (
        typeof row.id !== "string" || !requested.has(row.id) ||
        byId.has(row.id) ||
        row.namespace !== namespace
      ) invalidProjection();
      byId.set(row.id, row as CollectionRecord);
    }
  }
  // Return the requested order even when the owner query uses a different SQL order.
  return capturedIds.map((id) => byId.get(id)!);
}
