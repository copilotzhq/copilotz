/** One memory, as an agent reads it: the statement, whom it's about, its id. */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Memory } from "../collections/memory.ts";
import { line, peopleOf } from "../shared/scope.ts";
import { namesIn } from "../../../access/spaces/contract.ts";

/** People by name: notes from before names were known say ids, shown by name too. */
export const memoryView = (m: Memory, ctx: ViewContext) =>
  line(m, ctx.viewer?.name, namesIn(ctx, peopleOf(m)));
