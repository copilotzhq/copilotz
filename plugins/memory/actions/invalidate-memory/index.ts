/** Invalidates an accessible memory record with editorial provenance. @module */
import {
  type ContextSourceRef,
  coreToolActionMetadata,
} from "@copilotz/copilotz/core";
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";

import { memoryRecordCollection } from "../../collections/memory-record/index.ts";
import { memorySourceKey } from "../../authoring/ontology/index.ts";

import type { MemoryActionContext } from "../../internal/contracts.ts";
import { record, requiredText } from "../../internal/input.ts";
import { threadMemorySpaces } from "../../internal/access.ts";
import { memoryRecord } from "../../internal/retrieval.ts";

export const invalidateMemoryInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "disposition", "reason"],
  properties: {
    id: { type: "string", minLength: 1 },
    disposition: { enum: ["retracted", "superseded", "archived"] },
    reason: { type: "string", minLength: 1 },
    replacementMemoryId: { type: "string", minLength: 1 },
    sources: { type: "array", items: { type: "object" }, maxItems: 20 },
  },
} as const;

export const invalidateMemoryOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["memory"],
  properties: {
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["id", "status", "previousValidity", "validity"],
      properties: {
        id: { type: "string" },
        status: { type: "string" },
        previousValidity: { type: "object" },
        validity: { type: "object" },
        replacementMemoryId: { type: "string" },
      },
    },
  },
} as const;

function invalidationSources(
  value: unknown,
  triggerMessageId: string,
): readonly ContextSourceRef[] {
  const defaultSource: ContextSourceRef = {
    type: "message",
    id: triggerMessageId,
  } as const;
  if (value === undefined) return ([defaultSource] as const);
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError("Invalidation sources must be a non-empty array.");
  }
  const sources = value.map((raw) => {
    const source = record(raw);
    if (source.type !== "message" || source.id !== triggerMessageId) {
      throw new TypeError(
        "Invalidation sources may only cite the trusted triggering message.",
      );
    }
    return defaultSource;
  });
  return (sources.filter((source, index) =>
    sources.findIndex((candidate) =>
      memorySourceKey(candidate) === memorySourceKey(source)
    ) === index
  ));
}

export const invalidateMemoryAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema,
  typeof invalidateMemoryOutputSchema
> = defineAction<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema,
  typeof invalidateMemoryOutputSchema
>({
  id: "copilotz.memory.invalidate",
  inputSchema: invalidateMemoryInputSchema,
  outputSchema: invalidateMemoryOutputSchema,
  async execute(
    raw: unknown,
    context: MemoryActionContext,
  ) {
    const input = record(raw);
    const id = requiredText(input.id, "Memory id");
    const disposition = requiredText(input.disposition, "Memory disposition");
    if (
      disposition !== "retracted" && disposition !== "superseded" &&
      disposition !== "archived"
    ) {
      throw new TypeError("Memory disposition is invalid.");
    }
    const reason = requiredText(input.reason, "Memory invalidation reason");
    const provenance = coreToolActionMetadata(context.action.metadata);
    if (!provenance) {
      throw new Error(
        "invalidate_memory requires trusted Core Tool provenance.",
      );
    }
    const sources = invalidationSources(
      input.sources,
      provenance.triggerMessageId,
    );
    const writable = new Set(
      (await threadMemorySpaces(context, provenance.threadId)).filter((
        space,
      ) => space.access === "read_write").map((space) => space.id),
    );
    const item = await context.collections.memoryRecord.get({ id });
    const mapped = item ? memoryRecord(item) : null;
    if (!mapped) throw new Error(`Memory '${id}' was not found.`);
    if (!writable.has(mapped.memorySpaceId)) {
      throw new Error(`Memory '${id}' is not writable from this thread.`);
    }
    const replacementMemoryId = disposition === "superseded"
      ? requiredText(input.replacementMemoryId, "Replacement memory id")
      : undefined;
    if (replacementMemoryId === id) {
      throw new TypeError("A memory cannot supersede itself.");
    }
    if (replacementMemoryId) {
      const replacement = await context.collections.memoryRecord.get({
        id: replacementMemoryId,
      });
      const mappedReplacement = replacement ? memoryRecord(replacement) : null;
      if (
        !mappedReplacement || !writable.has(mappedReplacement.memorySpaceId)
      ) {
        throw new Error(
          `Replacement memory '${replacementMemoryId}' is not writable from this thread.`,
        );
      }
    } else if (input.replacementMemoryId !== undefined) {
      throw new TypeError(
        "replacementMemoryId is only valid for disposition 'superseded'.",
      );
    }
    const nextValidity = {
      status: disposition,
      changedAt: context.now().toISOString(),
      reason,
      sources,
      ...(replacementMemoryId ? { replacementMemoryId } : {}),
    } as const;
    const previousValidity = record(item!.validity);
    const operationKey = `memory-invalidate:${id}:${disposition}:${
      replacementMemoryId ?? ""
    }`;
    await context.transaction(async (tx) => {
      await tx.collections.memoryRecord.commands.invalidate({
        id,
        validity: nextValidity,
      }, { operationKey });
      if (replacementMemoryId) {
        await tx.relations.upsert({
          id: `memory-relation:${
            encodeURIComponent(`${replacementMemoryId}:supersedes:${id}`)
          }`,
          type: "supersedes",
          source: {
            type: memoryRecordCollection.name,
            id: replacementMemoryId,
          },
          target: { type: memoryRecordCollection.name, id },
          metadata: { sources, reason },
        });
      }
    }, { operationKey });
    const saved = await context.collections.memoryRecord.get({ id });
    const validity = saved ? record(saved.validity) : nextValidity;
    return {
      memory: {
        id,
        status: mapped.status,
        previousValidity,
        validity,
        ...(replacementMemoryId ? { replacementMemoryId } : {}),
      },
    };
  },
});

export default invalidateMemoryAction;
