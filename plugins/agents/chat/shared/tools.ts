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
import type { Context, Description, Resources, Viewer } from "../../../../runtime/mod.ts";
import { check } from "./agents.ts";
import type { ActionTool, Step, Tool, ToolContext } from "./types.ts";

/** Each `tools` resource's tools, made once: an Action's entry as the tool it is. */
const made = new WeakMap<object, Record<string, Tool>>();

/**
 * The app's tools: the `tools` resource, each entry that names an Action
 * (`{ action }`) made the tool it is, its input and description the Action's
 * (`describe()`), its run a call of the Action.
 */
export function toolsOf(ctx: { resources: Resources; describe?(): Description }): Record<
  string,
  Tool
> {
  const entries = (ctx.resources.tools ?? {}) as Record<string, Tool | ActionTool>;
  const kept = made.get(entries);
  if (kept) return kept;
  const actions = ctx.describe?.().actions ?? {};
  const tools: Record<string, Tool> = {};
  for (const [name, entry] of Object.entries(entries)) {
    if (!("action" in entry) || typeof (entry as { run?: unknown }).run === "function") {
      tools[name] = entry as Tool;
      continue;
    }
    const { action, description, ...rest } = entry;
    const def = actions[action];
    if (!def) throw new Error(`Tool "${name}" is the Action "${action}", which no plugin declares`);
    tools[name] = {
      ...rest,
      description: description ?? def.description ?? action,
      ...(def.input ? { input: def.input as Tool["input"] } : {}),
      run: (input, ctx) => ctx.call(action, input),
    };
  }
  made.set(entries, tools);
  return tools;
}

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
  const tools = toolsOf(ctx);
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
  const shown = await ctx.render(`tool:${call.name}`, call, { viewer });
  return typeof shown === "string" ? shown : call.output;
}
