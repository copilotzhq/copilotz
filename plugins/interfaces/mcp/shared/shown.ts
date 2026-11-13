/**
 * What a model outside reads of a call, on any server: what the app's own
 * agents read of it (its tool's `tool:<name>` View, read as whoever called),
 * never its output as it is; and of a failure, its message only when it's for
 * any caller (`failure(code, message, { public: true })`), else only that it
 * went wrong.
 */
import { type Context, isPublic } from "../../../../runtime/mod.ts";
import type { Step } from "../../../agents/chat/contract.ts";
import type { Server } from "./settings.ts";

/** What the model is told of a failure that isn't for it, and of a View that shows nothing. */
export const FAILED = "Something went wrong running that tool. Try again in a moment.";
export const HIDDEN = "It ran, but what it returned can't be shown.";

/** What a failed call tells the caller: a public failure's message, else only that it failed. */
export const toldOf = (error: unknown): string =>
  isPublic(error) && error instanceof Error && error.message
    ? error.message.slice(0, 1_000)
    : FAILED;

/**
 * What a call's result reads as to the app's agents, read as its caller: its tool's View, never
 * the output as it is; a View that fails, or says nothing, hides it.
 */
export async function shown(
  ctx: Pick<Context, "render">,
  line: Server,
  step: Step,
): Promise<string> {
  try {
    const text = await ctx.render(`tool:${step.name}`, step, {
      viewer: { kind: "agent", name: line.client },
    });
    return typeof text === "string" ? text : HIDDEN;
  } catch (error) {
    console.error(`mcp.${line.name}: tool:${step.name} failed to show:`, (error as Error).message);
    return HIDDEN;
  }
}
