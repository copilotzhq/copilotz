/** What agents remember, one per line: core ones starred, with whom it's about and who wrote it. */
import type { ViewContext } from "../../../../../runtime/mod.ts";
import { accent, dim } from "../../../../../hosts/terminal/mod.ts";
import type { Memory } from "../../collections/memory.ts";
import { peopleOf, subject } from "../../shared/scope.ts";
import { nameOf, namesIn, withNames } from "../../../../access/spaces/contract.ts";

/** People by name: whom it's about, who wrote it, and ids its text says (notes from before). */
export const memoryLine = (m: Memory, ctx?: ViewContext): string => {
  const names = ctx ? namesIn(ctx, peopleOf(m)) : {};
  return `${dim(`[${m._id}]`)} ${m.core ? accent("★ ") : ""}${withNames(m.text, names)} ${
    dim(`(${subject(m.about, undefined, names)}, by ${nameOf(m.by, names)})`)
  }`;
};
