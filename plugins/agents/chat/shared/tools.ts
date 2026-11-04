/**
 * Running one of the app's tools, as an agent's turn does: chat's tool
 * runner, for whoever else runs them (the MCP interface: a model outside
 * calling them), so a tool runs and reads the same however it's called.
 *
 * - `runTool`: its input checked against its schema, then run; what it
 *   returns as text (JSON unless it's text already); a throw, or input that
 *   doesn't fit, as `Error: <why>`, with the error itself beside it (and
 *   `unchecked` when the input didn't fit: it isn't the tool's input). What
 *   input doesn't fit says is about the caller's own input: public (see the
 *   runtime's `failure`).
 * - `toolText`: what a call's result reads as to a model: its tool's
 *   `tool:<name>` View (`llm`), else the result's own text.
 */
import type { Context, Viewer } from "../../../../runtime/mod.ts";
import { check } from "./agents.ts";
import type { Step, Tool, ToolContext } from "./types.ts";

/**
 * What a call ran into: its output as the agent's step keeps it, what was
 * thrown, if anything, and whether its input didn't fit the tool's schema.
 */
export type ToolRun = { output: string; error?: unknown; unchecked?: true };

/** Where a call runs: who calls it, in which thread, for what message, and the call's own id. */
export type ToolAt = Omit<ToolContext, keyof Context> & { retry: boolean };

/** Runs the tool `name` with `input`, as `ctx` (whose reach it has), where `at` says. */
export async function runTool(
  ctx: Context,
  name: string,
  input: unknown,
  at: ToolAt,
): Promise<ToolRun> {
  const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
  const tool = Object.hasOwn(tools, name) ? tools[name] : undefined;
  const failed = (error: unknown) =>
    `Error: ${error instanceof Error ? error.message : String(error)}`;
  try {
    if (!tool) throw new Error(`Unknown tool "${name}"`);
    check(name, tool)(input);
  } catch (error) {
    const told = Object.assign(error as Error, { public: true as const });
    return { output: failed(told), error: told, unchecked: true };
  }
  try {
    const result = await tool.run(input as Record<string, unknown>, { ...ctx, ...at });
    return { output: typeof result === "string" ? result : JSON.stringify(result) };
  } catch (error) {
    return { output: failed(error), error };
  }
}

/** What a call's result reads as to a model (`viewer`): its tool's View, else its output. */
export async function toolText(
  ctx: Pick<Context, "render">,
  call: Step,
  viewer: Viewer,
): Promise<string> {
  const shown = await ctx.render("llm", `tool:${call.name}`, call, { viewer });
  return typeof shown === "string" ? shown : call.output;
}
