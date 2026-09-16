/** Proposal validation, source references, and record relation preparation. @module */
import type {
  ContextSourceRef,
  ConversationMessage,
  FrozenContextContribution,
} from "@copilotz/copilotz/core";
import { addFormats, Ajv } from "../../../../dependencies/ajv.ts";

import type { MemoryRecordRelation } from "../../authoring/consolidation/index.ts";
import { memoryRecordCollection } from "../../collections/memory-record/index.ts";
import {
  defaultMemoryLifecycle,
  MEMORY_RELATION_TYPES,
  type MemoryDraftBase,
  type MemoryForm,
  type MemoryNodeRef,
  memorySourceKey,
  type ProposedMemoryRef,
} from "../../authoring/ontology/index.ts";
import type { MemoryProcessorContext } from "../../shared/contracts.ts";
import { record, requiredText } from "../../shared/input.ts";

type AjvValidator = ((value: unknown) => boolean) & {
  errors?: readonly unknown[] | null;
};

const memoryKindValidators = new WeakMap<object, AjvValidator>();

// deno-lint-ignore no-explicit-any
const memoryKindAjv = new (Ajv as any)({
  strict: false,
  allErrors: true,
  useDefaults: false,
});
// deno-lint-ignore no-explicit-any
(addFormats as any)(memoryKindAjv);

export function validateMemoryKindData(
  schema: object,
  value: unknown,
  label: string,
): void {
  let validator = memoryKindValidators.get(schema);
  if (!validator) {
    validator = memoryKindAjv.compile(schema) as AjvValidator;
    memoryKindValidators.set(schema, validator);
  }
  if (validator(structuredClone(value))) return;
  const details = memoryKindAjv.errorsText(validator.errors ?? [], {
    separator: "; ",
  });
  throw new TypeError(`${label}: ${details}`);
}

export function sourceCatalog(
  messages: readonly ConversationMessage[],
  snapshot: readonly FrozenContextContribution[],
) {
  const evidence: ContextSourceRef[] = [];
  const nodes = new Set<string>();
  for (const message of messages) {
    evidence.push({ type: "message", id: message.id });
    for (const ref of message.content) {
      evidence.push({ type: "asset", id: ref.assetId });
    }
  }
  for (const item of snapshot) {
    if (item.role === "evidence" && item.source) evidence.push(item.source);
    if (item.source?.type === "collection_record") {
      nodes.add(`${item.source.collection}:${item.source.id}`);
    }
  }
  return ({
    evidence: evidence,
    keys: new Set(evidence.map(memorySourceKey)),
    nodes,
  } as const);
}

export function assertedBy(
  sources: readonly ContextSourceRef[],
  messages: readonly ConversationMessage[],
): MemoryNodeRef | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const participantIds = new Set(
    sources.flatMap((source) => {
      if (source.type !== "message") return [];
      const participantId = byId.get(source.id)?.sender.id;
      return participantId ? [participantId] : [];
    }),
  );
  return participantIds.size === 1
    ? { type: "participant", id: [...participantIds][0] }
    : undefined;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(
        ",",
      )
    }}`;
  }
  return JSON.stringify(value);
}

export function resolveRef(
  ref: ProposedMemoryRef,
  local: ReadonlyMap<string, string>,
): MemoryNodeRef {
  if ("localId" in ref) {
    return {
      type: memoryRecordCollection.name,
      id: requiredText(
        local.get(ref.localId),
        `Memory local ref '${ref.localId}'`,
      ),
    };
  }
  if ("memoryId" in ref) {
    return { type: memoryRecordCollection.name, id: ref.memoryId };
  }
  return ref.node;
}

export function draftData(
  form: MemoryForm,
  draft: MemoryDraftBase & Record<string, unknown>,
  local: ReadonlyMap<string, string>,
) {
  const copy = structuredClone(draft) as Record<string, unknown>;
  for (
    const key of [
      "localId",
      "kind",
      "summary",
      "spaceId",
      "sources",
      "epistemic",
      "temporal",
      "status",
    ]
  ) delete copy[key];
  const mapRef = (value: unknown) =>
    resolveRef(value as ProposedMemoryRef, local);
  if (form === "assertion") {
    copy.subject = mapRef(copy.subject);
    const object = record(copy.object);
    if (object.ref) copy.object = { ref: mapRef(object.ref) };
  } else if (form === "occurrence" && Array.isArray(copy.participants)) {
    copy.participants = copy.participants.map(mapRef);
  } else if (form === "intent") {
    if (copy.owner) copy.owner = mapRef(copy.owner);
    if (copy.target) copy.target = mapRef(copy.target);
  } else if (form === "inquiry") {
    if (Array.isArray(copy.about)) copy.about = copy.about.map(mapRef);
    if (copy.answer) copy.answer = mapRef(copy.answer);
  }
  return copy;
}

export function intentOrInquiryStatus(
  form: MemoryForm,
  draft: Record<string, unknown>,
) {
  return (form === "intent" || form === "inquiry") &&
      typeof draft.status === "string"
    ? draft.status
    : defaultMemoryLifecycle(form);
}

export async function recordRelations(
  context: MemoryProcessorContext,
  ids: ReadonlySet<string>,
) {
  return ((await context.collections.memoryRecord.relations.list({
    types: MEMORY_RELATION_TYPES,
    limit: 1_000,
  }))
    .filter((relation) =>
      ids.has(relation.source.id) && ids.has(relation.target.id)
    )
    .map((relation): MemoryRecordRelation => ({
      sourceId: relation.source.id,
      targetId: relation.target.id,
      type: relation.type,
    })));
}
