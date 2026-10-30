/** Finding memories (by meaning and words) and keeping them (updating what they repeat). */
import type { Context, ReadContext } from "../../../../runtime/mod.ts";
import type { ToolContext } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import { vectors } from "./settings.ts";
import { now, overlap, readable, SAME, type Scope, shortId, words } from "./scope.ts";

type Scored = Memory & { _score: number };

/**
 * The memories most relevant to `text`, best first: by meaning (with an
 * embedder) and by shared words; `core` ones only when asked.
 */
export async function search(
  ctx: ReadContext | ToolContext,
  scope: Scope,
  text: string,
  limit: number,
  o: { core?: boolean; least?: number } = {},
): Promise<Scored[]> {
  const memories = ctx.db.collection<Memory>("memory");
  const filter = { ...readable(scope), ...(o.core ? {} : { core: { $ne: true } }) };
  const query = words(text);
  const [vector] = await vectors(ctx, [text]) ?? [];
  const candidates: Scored[] = vector
    ? await memories.nearest(vector, { filter, limit: limit * 4 })
    : (await memories.find(filter, { sort: { at: -1 }, limit: 500 })).map((m) => ({
      ...m,
      _score: 0,
    }));
  return candidates
    .map((m) => ({ ...m, _score: m._score + 0.2 * overlap(query, m.text) }))
    .filter((m) => m._score >= (o.least ?? 0) && (vector || m._score > 0))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

/**
 * Writes a memory, or updates the one it repeats (as similar as `SAME`, or
 * named by `id`). Returns what it did, in words for the agent.
 */
export async function keep(
  ctx: Pick<Context, "db" | "resources" | "call">,
  entry: {
    text: string;
    about: string;
    core?: boolean;
    by: string;
    source?: Memory["source"];
    in?: string;
  },
  id?: string,
): Promise<string> {
  const memories = ctx.db.collection<Memory>("memory");
  const [embedding] = await vectors(ctx, [entry.text]) ?? [];
  let existing: Memory | null = id
    ? await memories.findOne({ _id: id, forgotten: { $exists: false } })
    : null;
  if (id && !existing) return `Not remembered: there is no memory ${id}.`;
  if (!existing) {
    existing = embedding
      ? (await memories.nearest(embedding, {
        // The same thing, learned in the same space: what's learned here stays here.
        filter: {
          about: entry.about,
          forgotten: { $exists: false },
          ...(entry.in ? { in: entry.in } : {}),
        },
        limit: 1,
      })).find((m) => m._score >= SAME) ?? null
      : await memories.findOne({
        about: entry.about,
        text: entry.text,
        forgotten: { $exists: false },
        ...(entry.in ? { in: entry.in } : {}),
      });
  }
  if (existing) {
    if (
      existing.text === entry.text && (entry.core === undefined || entry.core === existing.core)
    ) {
      return `Already remembered [${existing._id}].`;
    }
    await memories.updateOne({ _id: existing._id }, {
      $set: {
        text: entry.text,
        was: existing.text,
        updated: now(),
        ...(entry.core !== undefined ? { core: entry.core } : {}),
        ...(embedding ? { embedding } : {}),
      },
    });
    return `Updated [${existing._id}]; it said: "${existing.text}".`;
  }
  const _id = shortId();
  await memories.insertOne({
    _id,
    text: entry.text,
    about: entry.about,
    ...(entry.core ? { core: true } : {}),
    by: entry.by,
    ...(entry.source ? { source: entry.source } : {}),
    ...(entry.in ? { in: entry.in } : {}),
    at: now(),
    ...(embedding ? { embedding } : {}),
  } as Memory);
  return `Remembered [${_id}].`;
}
