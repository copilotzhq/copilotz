/**
 * `mcp.call`: one call to one of the app's tools, from a model outside,
 * called by the MCP route as the conversation's contact (an actor only that
 * route makes: `{ kind: "contact", id, mcp: <line>, client }`), so the
 * owner checks it may, and everything it does is that contact's: the rules
 * keep it to its own chat. In order:
 *
 * 1. **Its chat**, which comes from the contact (see shared/keys.ts): in
 *    use, or new (the first call of a conversation), or closed (its people
 *    took the contact out of it: it stays closed), or unknown (a handle the
 *    app never gave: refused).
 * 2. **The line's limits**, counted in memory, the call itself included:
 *    its conversation's calls a minute, the line's, and new conversations an
 *    hour, the line's and the user's. Past one, the call is refused with a
 *    line saying so, and nothing is written.
 * 3. **A request sent again** is answered from its first answer, within two
 *    minutes of it (see collections/call.ts).
 * 4. **A new conversation** is made, as the system: its contact
 *    (`contact.start`, `via: "mcp"`) and its chat in the line's space,
 *    shared with it on its own (`contact.chat`).
 * 5. **The tool runs** through chat's runner, as the contact: its input
 *    checked, its `ctx.agent` the client (`ChatGPT`), its `ctx.thread` the
 *    chat, its `ctx.trigger` and `ctx.callId` the step.
 * 6. **The step** is written, as an agent's step is: a private message from
 *    the client, with the call, what it was given and what it returned. The
 *    chat page shows it; queries over steps read it like any other.
 * 7. **The answer** is what the app's own agents read of it (its
 *    `tool:<name>` View, else its output). An error says its message only
 *    when it's for the caller: a coded one, as the runtime's `failure`
 *    makes them (`invalid`, a tool's own `not_now`…), not the runtime's
 *    own (`executor_lost`…); a bare throw says only that it went wrong, and
 *    the step keeps what it was.
 *
 * It isn't recorded: the step is the call's record, and a tool's own
 * Actions are recorded as they are. Its input (what the model sent) stays
 * out of the log.
 */
import { type Context, defineAction, failure, linksOf } from "../../../../runtime/mod.ts";
import { runTool, type Step, type Thread, toolText } from "../../../agents/chat/contract.ts";
import { RESEND_MS } from "../collections/call.ts";
import { threadOf } from "../shared/keys.ts";
import { type Line, lineOf } from "../shared/settings.ts";

/** What a call answers: the text the model reads, whether it's an error, and whether its chat is on. */
export type Called = { text: string; isError?: true; kept: boolean };

/** What the model is told when a call can't go on. */
const SAID = {
  fast: "Too many calls in this conversation: wait a minute, then try again.",
  busy: "This app is busy right now: try again in a few minutes.",
  chats: "Too many new conversations with this app lately: try again later.",
  closed: "This conversation with the app was closed: it can't go on.",
  unknown:
    "That chat handle isn't one this app gave: leave `chat` out to start a new conversation.",
  failed: "Something went wrong running that tool. Try again in a moment.",
  hidden: "It ran, but what it returned can't be shown.",
} as const;

/**
 * The runtime's own codes, whose messages are about the app's insides (a lost executor, a call
 * stopped, a write that collided): a caller is told only that it failed.
 */
const INSIDE = new Set(["executor_lost", "cancelled", "duplicate_key", "id_conflict", "offline"]);

/** Writes whose answer isn't needed: a transaction sends them with its commit. */
const UPSERT = { upsert: true, writeConcern: { w: 0 } } as const;
const NONE = { writeConcern: { w: 0 } } as const;

const MINUTE = 60_000;
const HOUR = 3_600_000;

export const callAction = defineAction({
  description: "One call to one of the app's tools, from a model outside (MCP)",
  input: {
    type: "object",
    properties: {
      line: { type: "string" },
      tool: { type: "string" },
      input: { type: "object" },
      /** The call's id (`mcp:<thread>:<request id>:<what>`), as the route made it. */
      call: { type: "string", maxLength: 400 },
      /** What named its conversation: a session, a handle the app gave, or nothing (a new one). */
      by: { enum: ["session", "handle", "new"] },
      /** Who started it, when the client says (an HMAC of `openai/subject`): for their limit. */
      user: { type: "string", maxLength: 40 },
    },
    required: ["line", "tool", "input", "call", "by"],
    additionalProperties: false,
  },
  record: false,
  // Only a contact the MCP route made for this line: no other actor names a conversation here.
  allow: (actor, input) => actor.kind === "contact" && actor.mcp === input.line,
  run: async (ctx, input): Promise<Called> => {
    const line = lineOf(ctx, input.line);
    const links = linksOf(ctx.resources);
    const contact = ctx.actor?.id;
    if (!line || !links || !contact || !Object.hasOwn(line.tools, input.tool)) {
      throw failure("not_found", "No such tool on this line.");
    }
    const thread = await threadOf(links.secret, contact);
    const system = ctx.as();
    // Its chat: whether it's there (as the system), and whether its contact still reaches it.
    const [there, reached] = await Promise.all([
      system.db.collection<Thread>("thread").findOne({ _id: thread }),
      ctx.db.collection<Thread>("thread").findOne({ _id: thread }),
    ]);
    if (there && !reached) return { text: SAID.closed, isError: true, kept: false };
    if (!there && input.by === "handle") return { text: SAID.unknown, isError: true, kept: false };
    const fresh = !there;

    const taken = await counted(ctx, line, thread, input.call, fresh, input.user);
    if ("refused" in taken) return { text: taken.refused, isError: true, kept: !fresh };
    if (taken.answered) return { ...await again(ctx, line, taken.answered), kept: true };
    if (fresh) await opened(ctx, line, contact, thread);

    const at = new Date().toISOString();
    const ran = await runTool(ctx, input.tool, input.input, {
      agent: line.client,
      thread,
      trigger: taken.step,
      callId: taken.step,
      retry: taken.retry,
    });
    const step: Step = { id: input.call, name: input.tool, input: input.input, output: ran.output };
    const said = ran.error === undefined ? undefined : toldOf(ran.error);
    await system.transaction(async (tx) => {
      // A try cut short after its step was written writes it again, the same.
      await tx.db.collection("message").replaceOne({ _id: taken.step }, {
        thread,
        in: line.in,
        from: line.client,
        to: [],
        private: true,
        toolCalls: [step],
        at,
      }, UPSERT);
      await tx.db.collection("mcp_call").replaceOne(
        { _id: input.call },
        { step: taken.step, at: Date.now(), done: true, ...(said ? { said } : {}) },
        UPSERT,
      );
    });
    if (said) return { text: said, isError: true, kept: true };
    return { text: await shown(ctx, line, step), kept: true };
  },
});

/**
 * What a failed call tells the caller: a coded error's own message (a refusal made for whoever
 * calls, as the runtime's `failure` makes them: "That date is in the past."), else only that it
 * failed: a bare throw's words (a driver's, a stack's) may say what's inside.
 */
function toldOf(error: unknown): string {
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === "string" && code && !INSIDE.has(code) && typeof message === "string" &&
      message
    ? message.slice(0, 1_000)
    : SAID.failed;
}

/** What a call's result reads as to the app's agents, read as the contact; a View that fails hides it. */
async function shown(ctx: Context, line: Line, step: Step): Promise<string> {
  try {
    return await toolText(ctx, step, { kind: "agent", name: line.client });
  } catch (error) {
    console.error(`mcp.${line.name}: tool:${step.name} failed to show:`, (error as Error).message);
    return SAID.hidden;
  }
}

/** A call answered lately, answered again from its step. */
async function again(ctx: Context, line: Line, receipt: { step: string; said?: string }) {
  if (receipt.said) return { text: receipt.said, isError: true as const };
  const found = await ctx.as().db.collection<{ toolCalls?: Step[] }>("message")
    .findOne({ _id: receipt.step });
  const step = found?.toolCalls?.[0];
  return step
    ? { text: await shown(ctx, line, step) }
    : { text: SAID.failed, isError: true as const };
}

type Taken =
  | { refused: string }
  | { answered: { step: string; said?: string } }
  | { answered?: undefined; step: string; retry: boolean };

/**
 * The call, counted against the line's limits, and what to do with it:
 * refused, answered again, or run (as a new step, or as the one it was
 * when a try was cut short). One transaction, in memory.
 */
async function counted(
  ctx: Context,
  line: Line,
  thread: string,
  call: string,
  fresh: boolean,
  user?: string,
): Promise<Taken> {
  const now = Date.now();
  const { limits } = line;
  const minute = (Math.floor(now / MINUTE) + 1) * MINUTE;
  const hour = (Math.floor(now / HOUR) + 1) * HOUR;
  const counters = [
    { _id: `${line.name}|chat|${thread}`, until: minute, most: limits.perMinute, say: SAID.fast },
    { _id: `${line.name}|line`, until: minute, most: limits.linePerMinute, say: SAID.busy },
    ...(fresh
      ? [
        { _id: `${line.name}|chats`, until: hour, most: limits.chatsPerHour, say: SAID.busy },
        ...(user
          ? [{
            _id: `${line.name}|user|${user}`,
            until: hour,
            most: limits.userChatsPerHour,
            say: SAID.chats,
          }]
          : []),
      ]
      : []),
  ];
  return await ctx.as().transaction(async (tx) => {
    const rates = tx.db.collection<{ until: number; count: number }>("mcp_rate");
    const calls = tx.db.collection<{ step: string; at: number; done?: boolean; said?: string }>(
      "mcp_call",
    );
    const had = await rates.find({ _id: { $in: counters.map((c) => c._id) } });
    const receipt = await calls.findOne({ _id: call });
    let over: string | undefined;
    for (const c of counters) {
      const before = had.find((h) => h._id === c._id);
      const count = before && before.until > now ? before.count + 1 : 1;
      await rates.replaceOne({ _id: c._id }, { until: c.until, count }, UPSERT);
      if (count > c.most) over ??= c.say;
    }
    // Once a minute (the line's counter starting anew), what's past goes.
    const minuteOf = had.find((h) => h._id === counters[1]._id);
    if (!minuteOf || minuteOf.until <= now) {
      await rates.deleteMany({ until: { $lte: now } }, NONE);
      await calls.deleteMany({ at: { $lt: now - RESEND_MS } }, NONE);
    }
    if (over) return { refused: over };
    if (receipt && now - receipt.at < RESEND_MS) {
      if (receipt.done) return { answered: receipt };
      return { step: receipt.step, retry: true };
    }
    const step = `${call}@${now.toString(36)}`;
    await calls.replaceOne({ _id: call }, { step, at: now }, UPSERT);
    return { step, retry: false };
  });
}

/**
 * A new conversation's contact and chat, as the system: the line's space
 * (made or kept, when the app declares it), the contact, and its chat
 * there, shared with it. Two first calls at once may both try: the one that
 * finds the other's work done goes on.
 */
async function opened(ctx: Context, line: Line, contact: string, thread: string) {
  const system = ctx.as();
  const open = async () => {
    await system.call("space.keep", { id: line.in });
    await system.call("contact.start", { id: contact, in: line.in, via: "mcp" });
    await system.call("contact.chat", {
      contact,
      in: line.in,
      thread,
      title: line.client.slice(0, 120),
    });
  };
  try {
    await open();
  } catch (error) {
    if ((error as { code?: string }).code !== "duplicate_key") throw error;
    await open();
  }
}
