/** How history is summarized (the `history` resource, which an app patches): the model, a line's size, and the tail's and outline's budgets. */
import type { Resources } from "../../../../runtime/mod.ts";
import type { ModelRef } from "../../../models/contract.ts";

export type HistorySettings = {
  /** The model that writes summary lines (`"provider/model"`, …): a fast, cheap one does well. */
  summarizer: ModelRef;
  /** A line's size limit, in UTF-8 bytes (512: a dense paragraph). */
  line: number;
  /** Whole messages at the end: they grow to the second size, then the oldest become lines until the first (bytes). */
  tail: [number, number];
  /** The outline: it grows to the second size, then the most due pairs merge until the first (bytes). */
  outline: [number, number];
};

/** The defaults: everything but the summarizer, which the app names. */
export const DEFAULTS: Omit<HistorySettings, "summarizer"> = {
  line: 512,
  tail: [16_000, 48_000],
  outline: [64_000, 128_000],
};

/** History's settings, as configured. */
export const settingsOf = (ctx: { resources: Resources }): HistorySettings =>
  ({ ...DEFAULTS, ...ctx.resources.history }) as HistorySettings;
