/** A thread's latest messages, continued through the threads it forked from. */
import type { Collection } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { HISTORY } from "./agents.ts";

type Reads = {
  collection<T>(name: string): Pick<Collection<T>, "find" | "findOne" | "countDocuments">;
};

/** Only a guard: from `since` on, a summarized history's budget is what bounds them. */
const WHOLE = 5_000;

/**
 * Where an agent's window of a thread starts when nothing summarizes it: it
 * holds from HISTORY to twice that, and drops HISTORY at a time, so between
 * drops each prompt starts as the last one did (and the provider's cache
 * holds it).
 */
export const windowStart = (total: number) =>
  total <= 2 * HISTORY ? 0 : total - HISTORY - ((total - HISTORY) % HISTORY);

/**
 * A thread's messages, oldest first. A fork continues with its parent's, up
 * to the message it started at, and so on up the lineage; nothing is copied.
 * `agent` limits them to what that agent sees: the shared ones and its own
 * private steps. Which of its own:
 *
 * - `since` (where a summarized history turns whole, `""` before it does):
 *   every one from then on, and the latest HISTORY of what it inherited;
 * - `batched` (an agent's, unsummarized): the window `windowStart` says, and
 *   the latest HISTORY of what it inherited while that window starts at its
 *   first message;
 * - else the latest `limit` (HISTORY), through the lineage.
 *
 * Each level is one query the owner keeps cached: of a fixed size (the
 * window is sliced from the latest 2 × HISTORY), so the cache holds one entry
 * per thread and agent, not one per turn.
 */
export async function lineage(
  db: Reads,
  id: string,
  options: { agent?: string; limit?: number; since?: string; batched?: boolean } = {},
): Promise<Message[]> {
  const { agent, since } = options;
  const threads = db.collection<Thread>("thread");
  const messages = db.collection<Message>("message");
  const visible = agent ? { $or: [{ private: { $ne: true } }, { from: agent }] } : {};
  /** The latest `n` messages it sees in a thread, newest first. */
  const latest = (thread: string, n: number) =>
    messages.find({ thread, ...visible }).sort({ at: -1 }).limit(n);

  let level: Message[];
  let left: number;
  // How many of a parent's are read: HISTORY for an agent, as many as asked for a reader.
  const inherited = since !== undefined || options.batched ? HISTORY : options.limit ?? HISTORY;
  if (since !== undefined) {
    level = await messages.find({ thread: id, at: { $gte: since }, ...visible }).sort({ at: -1 })
      .limit(WHOLE);
    left = HISTORY;
  } else if (options.batched) {
    const total = await messages.countDocuments({ thread: id, ...visible });
    const start = windowStart(total);
    level = (await latest(id, 2 * HISTORY)).slice(0, Math.max(1, total - start));
    left = start ? 0 : HISTORY;
  } else {
    const limit = options.limit ?? HISTORY;
    level = await latest(id, limit);
    left = limit - level.length;
  }
  const levels: Message[][] = [level];
  for (let current = await threads.findOne({ _id: id }); left > 0;) {
    if (!current?.fork || !current.parent) break;
    const { thread, message } = current.parent;
    const from = await messages.findOne({ _id: message });
    if (!from) break;
    // The parent's latest window usually reaches back to the fork point; when
    // it doesn't, ask for the messages up to it.
    const window = await latest(thread, inherited);
    level = window.filter((m) => m.at <= from.at);
    if (window.length === inherited && level.length < left) {
      level = await messages.find({ thread, at: { $lte: from.at }, ...visible })
        .sort({ at: -1 }).limit(inherited);
    }
    level = level.slice(0, left);
    levels.push(level);
    left -= level.length;
    current = await threads.findOne({ _id: thread });
  }
  // Each level is newest first, and older than the one before it.
  return levels.flat().reverse();
}
