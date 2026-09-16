import type { CollectionPredicate } from "@copilotz/copilotz/collections";
/** Semantic-memory record projection and candidate retrieval. @module */
import { type AgentResource, loadThreadRecord } from "@copilotz/copilotz/core";
import type {
  CollectionRecord,
  SnapshotCollections,
} from "@copilotz/copilotz/collections";

import type {
  MemoryRecordProjection,
  MemorySpaceDescriptor,
} from "../authoring/consolidation/index.ts";
import { MEMORY_FORMS, type MemoryForm } from "../authoring/ontology/index.ts";
import type { MemoryEmbed } from "../authoring/contracts/index.ts";
import type { MemoryProcessorContext } from "./contracts.ts";
import { optionalText, record } from "./input.ts";

export function memoryRecord(
  value: CollectionRecord,
): MemoryRecordProjection | null {
  const form = optionalText(value.form) as MemoryForm | undefined;
  const memorySpaceId = optionalText(value.memorySpaceId);
  const kind = optionalText(value.kind);
  const summary = optionalText(value.summary);
  const status = optionalText(value.status);
  const validity = optionalText(record(value.validity).status);
  return form && MEMORY_FORMS.includes(form) && memorySpaceId && kind &&
      summary && status &&
      (validity === "valid" || validity === "retracted" ||
        validity === "superseded" || validity === "archived")
    ? ({
      id: value.id,
      memorySpaceId,
      form,
      kind,
      summary,
      status,
      validity,
      data: record(value.data),
    })
    : null;
}

export async function activeMemoryRecords(
  context: { collections: SnapshotCollections },
  spaces: readonly MemorySpaceDescriptor[],
) {
  const readable = new Set(spaces.map((space) => space.id));
  const values = await context.collections.memoryRecord.list({
    filter: { field: "memorySpaceId", in: [...readable] },
    limit: 1_000,
  });
  return values.flatMap((value) => {
    if (!readable.has(String(value.memorySpaceId))) return [];
    const mapped = memoryRecord(value);
    return mapped ? [mapped] : [];
  });
}

export function terminalStatus(status: string): boolean {
  return [
    "superseded",
    "retracted",
    "cancelled",
    "obsolete",
    "deprecated",
    "merged",
    "archived",
  ].includes(status);
}

export function finiteEmbedding(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function lexicalScore(query: string, candidate: string): number {
  const words = (value: string) =>
    new Set(value.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  const wanted = words(query);
  const found = words(candidate);
  if (!wanted.size || !found.size) return 0;
  let overlap = 0;
  for (const word of wanted) if (found.has(word)) overlap++;
  return overlap / Math.sqrt(wanted.size * found.size);
}

export async function candidateRecords(
  context: MemoryProcessorContext,
  input: Readonly<{
    query: string;
    form: MemoryForm;
    kind: string;
    spaces: readonly MemorySpaceDescriptor[];
    agent: AgentResource;
    threadId: string;
    checkpointId: string;
    limit: number;
    embed?: MemoryEmbed;
  }>,
) {
  const thread = await loadThreadRecord(context, input.threadId);
  if (!thread) {
    throw new Error(`Memory thread '${input.threadId}' was not found.`);
  }
  const filter = memoryFilter(input.spaces, {
    form: input.form,
    kind: input.kind,
  });
  if (input.embed && input.query) {
    const profile = context.resources.memory?.embeddingProfile;
    if (!profile) {
      throw new Error(
        "Memory embedding requires resources.memory.embeddingProfile.",
      );
    }
    const values = await input.embed([input.query], {
      agent: input.agent,
      thread,
      checkpointId: input.checkpointId,
      context,
    });
    const matches = await context.vectors.search({
      ownerType: "memory_record",
      field: "summary",
      profile,
      values: values[0],
      filter,
      limit: input.limit,
    });
    return matches.flatMap(({ record: raw, distance }) => {
      const mapped = memoryRecord(raw);
      return mapped
        ? [{
          raw,
          record: mapped,
          score: vectorSimilarity(profile.metric, distance),
        }]
        : [];
    });
  }
  const candidates = await context.collections.memoryRecord.list({
    filter,
    limit: 1000,
  });
  return candidates.flatMap((item) => {
    const mapped = memoryRecord(item);
    if (!mapped) return [];
    return [{
      raw: item,
      record: mapped,
      score: lexicalScore(input.query, mapped.summary),
    }];
  }).sort((left, right) =>
    right.score - left.score || left.record.id.localeCompare(right.record.id)
  ).slice(0, input.limit);
}

/** Memory owns authorization/editorial policy; persistence owns distance calculation. */
export function memoryFilter(
  spaces: readonly MemorySpaceDescriptor[],
  input: {
    form?: unknown;
    kind?: unknown;
    status?: unknown;
    includeHistory?: unknown;
  },
): CollectionPredicate {
  const and: CollectionPredicate[] = [{
    field: "memorySpaceId",
    in: spaces.map((space) => space.id),
  }];
  for (const key of ["form", "kind", "status"] as const) {
    if (typeof input[key] === "string") {
      and.push({ field: key, eq: input[key] as string });
    }
  }
  if (input.includeHistory !== true) {
    and.push({ field: "validity.status", eq: "valid" }, {
      not: {
        field: "status",
        in: [
          "superseded",
          "retracted",
          "cancelled",
          "obsolete",
          "deprecated",
          "merged",
          "archived",
        ],
      },
    });
  }
  return { and };
}
export function vectorSimilarity(metric: string, distance: number): number {
  return metric === "cosine"
    ? 1 - distance
    : metric === "innerProduct"
    ? -distance
    : 1 / (1 + distance);
}
