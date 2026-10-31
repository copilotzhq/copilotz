/**
 * History: chat history that never outgrows the prompt, after optchat's design ("the
 * chat itself is the memory"):
 *
 * - Every shared message stays whole, forever. As it leaves the tail, a cheap
 *   model compresses it into one line (`summary`, level 0) and merges adjacent
 *   lines in pairs (levels 1, 2, …): a binary tree over the thread. A short
 *   message is its own line, two short lines are simply joined, and a
 *   conversation that stays within the tail never calls the model.
 * - An agent is sent the recent messages whole (the tail) and, before them,
 *   the rest as summary lines (the outline): fine for what's recent, coarser
 *   with age. `zoom(id, n)` opens a line into the two it was made from, down
 *   to the message itself, so nothing is lost.
 * - The tail and the outline grow at their end and shrink in batches (a
 *   sawtooth), so between batches each prompt starts with the last one and
 *   reads it from the provider's prompt cache.
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { outline } from "./collections/outline.ts";
import { summary } from "./collections/summary.ts";
import { compactor } from "./processors/compact.ts";
import { zoom } from "./resources/tools.ts";
import { settingsOf } from "./shared/settings.ts";
import { historyView } from "./views/history.ts";
import { sinceView } from "./views/since.ts";
import { summaryView } from "./views/summary.ts";

export type { HistorySettings } from "./shared/settings.ts";
export type { Outline } from "./collections/outline.ts";
export type { Summary } from "./collections/summary.ts";

/**
 * Summarizes each thread's older messages as they leave its tail, and sends
 * agents the outline and the recent messages whole (it replaces chat's
 * `history` View).
 */
export const history: Plugin = definePlugin({
  name: "history",
  requires: ["chat", "models"],
  collections: { summary, outline },
  views: {
    history: { llm: historyView },
    "history.since": { llm: sinceView },
    summary: { llm: summaryView },
  },
  resources: { tools: { zoom } },
  processors: { "history.compact": compactor },
  async check(merged) {
    const { summarizer } = settingsOf(merged);
    if (!summarizer) throw new Error("history: set the history resource's summarizer model");
    await merged.call("models.check", { model: summarizer, port: "llm" });
  },
});

export default history;
