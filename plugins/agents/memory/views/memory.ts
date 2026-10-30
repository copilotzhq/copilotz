/** One memory, as an agent reads it: the statement, whom it's about, its id. */
import type { ViewContext } from "../../../../runtime/mod.ts";
import type { Memory } from "../collections/memory.ts";
import { line } from "../shared/scope.ts";

export const memoryView = (m: Memory, ctx: ViewContext) => line(m, ctx.viewer?.name);
