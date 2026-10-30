/** What agents remember, one per line: core ones starred, with whom it's about and who wrote it. */
import { accent, dim } from "../../../../../hosts/terminal/mod.ts";
import type { Memory } from "../../collections/memory.ts";

export const memoryLine = (m: Memory): string =>
  `${dim(`[${m._id}]`)} ${m.core ? accent("★ ") : ""}${m.text} ${dim(`(${m.about}, by ${m.by})`)}`;
