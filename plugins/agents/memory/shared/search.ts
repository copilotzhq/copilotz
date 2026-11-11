/** Finding memories (by meaning and words) and keeping them (updating what they repeat). */
import type { Context, ReadContext } from "../../../../runtime/mod.ts";
import type { ToolContext } from "../../chat/contract.ts";
import type { Memory } from "../collections/memory.ts";
import { vectors } from "./settings.ts";
import { now, overlap, readable, SAME, type Scope, shortId, words } from "./scope.ts";

type Scored = Memory & { _score: number };

/**
 * The memories most relevant to `text`, best first: by meaning (with an
 * embedder) and by shared words; `core` ones only when asked (or those
 * learned since `coreSince`). Several texts (a message and what came before
 * it): each memory scores by the one it's closest to.
 */
export async function search(
  ctx: ReadContext | ToolContext,
  scope: Scope,
  text: string | string[],
  limit: number,
  o: { core?: boolean; coreSince?: string; least?: number } = {},
): Promise<Scored[]> {
  const memories = ctx.db.collection<Memory>("memory");
  const filter = {
    ...readable(scope),
    ...(o.core
      ? {}
      : o.coreSince
      ? { $or: [{ core: { $ne: true } }, { at: { $gte: o.coreSince } }] }
      : { core: { $ne: true } }),
  };
  const texts = [...new Set([text].flat().filter((t) => t.trim()))];
  if (!texts.length) return [];
  const queries = texts.map(words);
  const found = await vectors(ctx, texts, {
    thread: scope.thread,
    ...(scope.in ? { space: scope.in } : {}),
  });
  // Each memory, at its closest: by meaning to any of the texts, plus the words it shares with it.
  const best = new Map<string, Scored>();
  const score = (m: Scored) => {
    const total = m._score + 0.2 * Math.max(...queries.map((q) => overlap(q, m.text)));
    if (total > (best.get(m._id)?._score ?? -Infinity)) best.set(m._id, { ...m, _score: total });
  };
  if (found) {
    const near = await Promise.all(
      found.map((vector) => memories.nearest(vector, { filter, limit: limit * 4 })),
    );
    near.flat().forEach(score);
  } else {
    (await memories.find(filter, { sort: { at: -1 }, limit: 500 }))
      .forEach((m) => score({ ...m, _score: 0 }));
  }
  return [...best.values()]
    .filter((m) => m._score >= (o.least ?? 0) && (found || m._score > 0))
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
  const [embedding] = await vectors(ctx, [entry.text], {
    ...(entry.source?.thread ? { thread: entry.source.thread } : {}),
    ...(entry.in ? { space: entry.in } : {}),
  }) ?? [];
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
