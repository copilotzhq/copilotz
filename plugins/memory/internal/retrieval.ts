/** Semantic-memory record projection and candidate retrieval. @module */
import { type AgentResource, loadThreadRecord } from "@copilotz/copilotz/core";
import type {
  CollectionRecord,
  SnapshotCollections,
} from "@copilotz/copilotz/collections";

import {
  isEditoriallyVisible,
  type MemoryRecordProjection,
  type MemorySpaceDescriptor,
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

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
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
  const readable = new Set(input.spaces.map((space) => space.id));
  const candidates = (await context.collections.memoryRecord.list({
    where: {
      form: input.form,
      kind: input.kind,
    },
    filter: { field: "memorySpaceId", in: [...readable] },
    limit: 1_000,
  })).filter((item) =>
    readable.has(String(item.memorySpaceId)) &&
    isEditoriallyVisible(memoryRecord(item)!) &&
    !terminalStatus(String(item.status))
  );
  let queryEmbedding: readonly number[] | undefined;
  if (input.embed && input.query) {
    const values = await input.embed([input.query], {
      agent: input.agent,
      thread,
      checkpointId: input.checkpointId,
      context,
    });
    if (finiteEmbedding(values[0])) queryEmbedding = values[0];
  }
  return candidates.flatMap((item) => {
    const mapped = memoryRecord(item);
    if (!mapped) return [];
    const embedding = finiteEmbedding(item.embedding)
      ? item.embedding
      : undefined;
    return [{
      raw: item,
      record: mapped,
      score: queryEmbedding && embedding
        ? cosine(queryEmbedding, embedding)
        : lexicalScore(input.query, mapped.summary),
    }];
  }).sort((left, right) =>
    right.score - left.score || left.record.id.localeCompare(right.record.id)
  ).slice(0, input.limit);
}
