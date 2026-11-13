/**
 * `mcp.public`: one call to one of a public server's tools (`public: true`),
 * called by the MCP route as the public (`{ kind: "public", id: "", mcp:
 * <server>, in }`), and kept nowhere: no contact, no chat, no step, no
 * receipt, no counter, and, unrecorded, no event. Its tool runs through
 * chat's runner as the public, in the server's space (`ctx.in`), its
 * `ctx.agent` the server's client, in no chat (`ctx.thread` is empty), its
 * `ctx.callId` new each call (no call is run again as itself: there's
 * nothing to find it by). The answer is what the app's own agents read of it
 * (its `tool:<name>` View, read as the public), and a failure says its
 * message only when it's for any caller.
 *
 * Only tools the server offers the public run (see `forThePublic`: those
 * that only read). What they read is what the public reaches, and whatever
 * they try to write is refused by the rules: the public writes nothing. What
 * they call is asked its `allow` for the public (`publicCallers`). A tool's
 * own recorded Actions are still recorded, each call: a public tool reads
 * through unrecorded ones (`record: false`) to keep nothing.
 *
 * A call past the server's `timeout` is stopped: its tool's `ctx.signal`
 * aborts, and it answers that it took too long.
 */
import { defineAction, failure, publicCallers } from "../../../../runtime/mod.ts";
import type { Step, Tool } from "../../../agents/chat/contract.ts";
import { runTool } from "../../../agents/chat/contract.ts";
import { forThePublic, serverOf } from "../shared/settings.ts";
import { shown, toldOf } from "../shared/shown.ts";

/** What a public call answers: the text the model reads, and whether it's an error. */
export type PublicCalled = { text: string; isError?: true };

/** What the model is told of a call stopped at the server's timeout. */
export const TOO_LONG = "It took too long, so it was stopped: try again in a moment.";

export const publicAction = defineAction({
  description: "One call to one of a public server's tools, as the public (MCP): kept nowhere",
  input: {
    type: "object",
    properties: {
      line: { type: "string" },
      tool: { type: "string" },
      input: { type: "object" },
    },
    required: ["line", "tool", "input"],
    additionalProperties: false,
  },
  record: false,
  // Only the public the MCP route makes for this server: no other actor calls here.
  allow: (actor, input) =>
    publicCallers(actor) && typeof actor.mcp === "string" &&
    actor.mcp === (input as { line?: unknown })?.line,
  run: async (ctx, input): Promise<PublicCalled> => {
    const line = serverOf(ctx, input.line);
    const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
    const tool = Object.hasOwn(tools, input.tool) ? tools[input.tool] : undefined;
    if (!line?.public || !forThePublic(line, input.tool, tool)) {
      throw failure("not_found", "No such tool on this line.");
    }
    // Its signal aborts at the server's timeout, as well as when the call is stopped: followed
    // by a listener on the call's own signal, never `AbortSignal.any` (whose sources keep a
    // record of every signal made from them, a call's worth of memory each).
    const stop = new AbortController();
    const stopped = () => stop.abort();
    if (ctx.signal.aborted) stop.abort();
    else ctx.signal.addEventListener("abort", stopped, { once: true });
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      stop.abort();
    }, line.limits.timeout * 1000);
    const callId = `mcp-public:${crypto.randomUUID()}`;
    try {
      const ran = await runTool(
        { ...ctx, signal: stop.signal },
        input.tool,
        input.input,
        { agent: line.client, thread: "", trigger: callId, callId, retry: false },
      );
      if (late) return { text: TOO_LONG, isError: true };
      if (ran.error !== undefined) return { text: toldOf(ran.error), isError: true };
      const call: Step = { id: callId, name: input.tool, input: input.input, output: ran.output };
      return { text: await shown(ctx, line, call) };
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", stopped);
    }
  },
});
