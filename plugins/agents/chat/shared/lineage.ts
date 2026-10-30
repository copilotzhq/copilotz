/** A thread's latest messages, continued through the threads it forked from. */
import type { Collection } from "../../../../runtime/mod.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import { HISTORY } from "./agents.ts";

type Reads = { collection<T>(name: string): Pick<Collection<T>, "find" | "findOne"> };

/**
 * A thread's latest messages, oldest first. A fork continues with its parent's,
 * up to the message it started at, and so on up the lineage; nothing is
 * copied. `agent` limits them to what that agent sees: the shared ones and its
 * own private steps. Each level is one query the owner keeps cached.
 */
export async function lineage(
  db: Reads,
  id: string,
  options: { agent?: string; limit?: number; since?: string } = {},
): Promise<Message[]> {
  const { agent, since } = options;
  // From `since` on (where a summarized history turns whole), every message; else the latest.
  const limit = since ? 1_000 : options.limit ?? HISTORY;
  const threads = db.collection<Thread>("thread");
  const messages = db.collection<Message>("message");
  const visible = agent ? { $or: [{ private: { $ne: true } }, { from: agent }] } : {};
  /** The latest messages it sees in a thread, newest first: one query per thread and agent. */
  const latest = (thread: string) =>
    messages.find({ thread, ...visible }).sort({ at: -1 }).limit(limit);
  const levels: Message[][] = [];
  let left = limit;
  let level = since
    ? await messages.find({ thread: id, at: { $gte: since }, ...visible }).sort({ at: -1 })
      .limit(limit)
    : await latest(id);
  for (let current = await threads.findOne({ _id: id });;) {
    levels.push(level.slice(0, left));
    left -= Math.min(level.length, left);
    if (!left || !current?.fork || !current.parent) break;
    const { thread, message } = current.parent;
    const from = await messages.findOne({ _id: message });
    if (!from) break;
    // The parent's latest window usually reaches back to the fork point; when
    // it doesn't, ask for the messages up to it.
    const window = await latest(thread);
    level = window.filter((m) => m.at <= from.at);
    if (window.length === limit && level.length < left) {
      level = await messages.find({ thread, at: { $lte: from.at }, ...visible })
        .sort({ at: -1 }).limit(limit);
    }
    current = await threads.findOne({ _id: thread });
  }
  // Each level is newest first, and older than the one before it.
  return levels.flat().reverse();
}
