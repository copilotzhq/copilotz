/**
 * A public server (`public: true`), as the MCP route answers for it: open to
 * anyone, and keeping nothing.
 *
 * - **Who calls** is the public: `{ kind: "public", id: "", mcp: <server>,
 *   in }` (`publicOf`), never a contact. What names a conversation
 *   (`openai/session`, a `chat` handle) names nothing here, and there's no
 *   handle to give: tools are listed without `chat`, and answers end without
 *   one.
 * - **What's listed** (`publicTools`): of the server's tools, those it offers
 *   the public (`forThePublic`: the ones that only read), and of those, ones
 *   whose `offer` says no to the public (asked as it, in no chat) aren't.
 *   Any other isn't listed, and is unknown when called.
 * - **A call** (`publicCalled`) takes its places at once (on the server, from
 *   the caller's address: past either, it's busy), then its place in the
 *   minute (from the address, `ipPerMinute`; on the server, `linePerMinute`:
 *   past either, the model is told to wait; see limits.ts), then runs
 *   `mcp.public` as the public (see actions/public.ts). The route waits the
 *   server's `timeout` for its answer; past it, the call is stopped, and the
 *   model told it took too long. Its places at once are held until it's
 *   done, so a tool that ignores its signal can't let more in.
 * - **The caller's address** is read as the app's front says it (the `caller`
 *   resource: its header, believed only with its secret or through its
 *   proxies' hops; one it exempts isn't limited by address), else as the
 *   socket says (the peer the listener saw: never a header anyone may send);
 *   one that can't be read is counted with every other such call, as one
 *   caller. Behind a proxy without `caller`, every call comes from the proxy:
 *   one caller.
 */
import {
  type Caller,
  callerFrom,
  type CallerSettings,
  clientAddress,
  countedOf,
  type Runtime,
  UNVOUCHED,
} from "../../../../runtime/mod.ts";
import type { Tool } from "../../../agents/chat/contract.ts";
import { type PublicCalled, TOO_LONG } from "../actions/public.ts";
import { forThePublic, publicOf, type Server } from "../shared/settings.ts";
import { minuteOf } from "./limits.ts";
import { busy, hold } from "./running.ts";
import { type Answered, offeredOf } from "./tools.ts";

/** What the model is told past a minute's calls: from its address, and on the server. */
const SLOW = "Too many calls from here: wait a minute, then try again.";
const FULL = "This app is busy right now: try again in a few minutes.";

/**
 * Who calls a public server: as the app's front says (`caller`), else as the socket does, else
 * every caller whose address can't be read, as one.
 */
export function publicCaller(
  request: Request,
  settings: CallerSettings | undefined,
  exempt?: string[],
): Caller {
  if (settings) return callerFrom(request, settings, exempt)!;
  const peer = clientAddress(request);
  return { counted: (peer && countedOf(peer)) || UNVOUCHED, exempt: false };
}

/** The server's tools it lists for the public, in order. */
export function publicTools(
  runtime: Pick<Runtime, "describe" | "observe">,
  line: Server,
): Promise<string[]> {
  const tools = (runtime.describe().resources.tools ?? {}) as Record<string, Tool>;
  const names = Object.keys(line.tools).filter((name) =>
    forThePublic(line, name, Object.hasOwn(tools, name) ? tools[name] : undefined)
  );
  return offeredOf(runtime, line, names);
}

/** Runs a call to a public server's tool `tool` (one it lists), as the public. */
export async function publicCalled(
  runtime: Pick<Runtime, "call">,
  line: Server,
  call: { tool: string; input: Record<string, unknown>; caller: Exclude<Caller, "refused"> },
): Promise<Answered> {
  const address = call.caller.exempt ? undefined : call.caller.counted;
  const release = hold(runtime, [
    { key: `server:${line.name}`, most: line.limits.atOnce },
    ...(address
      ? [{ key: `address:${line.name}|${address}`, most: line.limits.addressAtOnce }]
      : []),
  ]);
  if (!release) throw busy();
  let running: Promise<unknown> | undefined;
  try {
    const past = minuteOf(runtime, line.name).take(address, {
      address: line.limits.ipPerMinute,
      all: line.limits.linePerMinute,
    });
    if (past) return answer(past === "address" ? SLOW : FULL, true);
    const started = runtime.call<PublicCalled>(
      "mcp.public",
      { line: line.name, tool: call.tool, input: call.input },
      { actor: publicOf(line) },
    );
    running = started.catch(() => {});
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      waiting = setTimeout(() => resolve("late"), line.limits.timeout * 1000);
    });
    const done = await Promise.race([started, late]).finally(() => clearTimeout(waiting));
    if (done === "late") return answer(TOO_LONG, true);
    const text = done.text.length > line.limits.result
      ? `${done.text.slice(0, line.limits.result)}\n[…cut]`
      : done.text;
    return answer(text, !!done.isError);
  } finally {
    // Its places go once it's done, answered or not.
    if (running) void running.finally(release);
    else release();
  }
}

const answer = (text: string, isError: boolean): Answered => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError: true } : {}),
});
