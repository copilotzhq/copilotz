/**
 * `mcp.call`: one call to one of the app's tools, from a model outside,
 * called by the MCP route as the conversation's contact (an actor only that
 * route makes: `{ kind: "contact", id, mcp: <line>, client }`), so the
 * owner checks it may, and everything it does is that contact's: the rules
 * keep it to its own chat. In order:
 *
 * 1. **Its chat**, which comes from the contact (see shared/keys.ts; under
 *    the app's secret, or the one before it for a conversation made then): in
 *    use, or new (the first call of a conversation), or begun (a first call
 *    cut short between making the chat and sharing it with the contact, as
 *    an owner restarting does: it goes on as new; see
 *    collections/opening.ts), or over (erased, or its people took the
 *    contact out of it: it stays so), or unknown (a handle the app never
 *    gave: refused). Nothing is counted or made for these last two.
 * 2. **The line's limits:** its conversation's calls a minute, the caller's
 *    address's, the line's; for a new conversation, new ones an hour, the
 *    line's, the user's, the address's. Past one, the call is refused with a
 *    line saying so, and nothing is written. Only a call taken counts, and a
 *    new conversation once it's made. Counts are read, then added to, in
 *    single writes: calls at once (8 on a line) can pass a limit by as many.
 * 3. **Offered?** A tool whose `offer` is a function decides, for the
 *    contact in its chat (see views/offered.ts).
 * 4. **A tool that changes things** keeps a receipt, by what it asks in the
 *    conversation (its tool and input, whatever the request's id), written
 *    before it runs (see collections/receipt.ts): asked again within two
 *    minutes of its answer, it's answered what it said, saying it wasn't
 *    done again; begun and never done (stopped, an owner restarted, failed
 *    by accident: "try again"), it runs again as the same step. A public
 *    refusal is an answer, and is said again. A read-only tool keeps none:
 *    it always runs.
 * 5. **A new conversation** is made, as the system: its contact
 *    (`contact.start`, `via: "mcp"`) and its chat in the line's space,
 *    shared with it on its own (`contact.chat`). Its opening is noted with
 *    the call's counts (`mcp_opening`), and goes once the chat is shared.
 * 6. **The tool runs** through chat's runner, as the contact: its input
 *    checked, its `ctx.agent` the client (`ChatGPT`), its `ctx.thread` the
 *    chat, its `ctx.callId` and `ctx.trigger` the step (the same however
 *    often a call cut short runs again: the key for what it does outside; a
 *    new call, the same request asked again later, has a new one). The
 *    route waits for it the line's `timeout`, and stops it past `stop` (its
 *    `ctx.signal` aborts): a tool that changes things, stopped, isn't done,
 *    and asked again runs again as itself, with `retry`.
 * 7. **The step** is written, as an agent's step is: a private message from
 *    the client in the chat (where the chat is now), with the call, what it
 *    was given (only input that fit the tool's schema; else a short note of
 *    what was sent) and what it returned. The chat page shows it; queries
 *    over steps read it; its `message.created` event carries it, as an
 *    agent's step's does.
 * 8. **The answer** is what the app's own agents read of it (its
 *    `tool:<name>` View), never its output as it is. An error says its
 *    message only when it's for any caller (`failure(code, message, {
 *    public: true })`, and input that didn't fit); any other says only that
 *    it went wrong, and the step keeps what it was.
 *
 * **A widget's own call** (`app`: an Action offered to the line's widgets,
 * or their read tool; the route checked the widget's grant first) is only
 * admitted here: its conversation must be one already (made by a call of
 * the model's, whose result drew the widget), not over, and within its
 * calls a minute (the conversation's, the address's, the line's), which it
 * counts. The route then calls the Action, or answers the reads, as the
 * contact: its `allow` and the rules decide, as a browser's call.
 *
 * It isn't recorded: the step is the call's record, and a tool's own
 * Actions are recorded as they are.
 */
import {
  type Context,
  defineAction,
  failure,
  isPublic,
  linksOf,
  secretsOf,
} from "../../../../runtime/mod.ts";
import type { Step, Thread, Tool } from "../../../agents/chat/contract.ts";
import { runTool } from "../../../agents/chat/contract.ts";
import { RERUN_MS, RESEND_MS } from "../collections/receipt.ts";
import { sameCallOf, threadOf } from "../shared/keys.ts";
import { appOnly, hintsOf, READ, type Server, serverOf } from "../shared/settings.ts";
import type { Offering } from "../views/offered.ts";

/**
 * What a call answers: the text the model reads, whether it's an error, whether it ran, and
 * whether it's what an earlier, identical call answered (`again`), not done twice.
 */
export type Called = {
  text: string;
  isError?: true;
  ran: boolean;
  again?: true;
  /** What the tool returned, as it is, for a tool shown through a widget (16 KiB at most). */
  output?: string;
  /** A widget's own call (`app`), admitted: the route makes it. */
  admitted?: true;
};

/** The most of a tool's output a widget is handed. */
const OUTPUT = 16_384;

/** What the model is told when a call can't go on. */
const SAID = {
  fast: "Too many calls in this conversation: wait a minute, then try again.",
  slow: "Too many calls from here: wait a minute, then try again.",
  busy: "This app is busy right now: try again in a few minutes.",
  chats: "Too many new conversations with this app lately: try again later.",
  closed: "This conversation with the app is over: it can't go on.",
  unknown:
    "That chat handle isn't one this app gave: leave `chat` out to start a new conversation.",
  unoffered: "That tool isn't offered here.",
  failed: "Something went wrong running that tool. Try again in a moment.",
  hidden: "It ran, but what it returned can't be shown.",
} as const;

/** Writes whose answer isn't needed: a transaction of only these is one command, never held. */
const UNANSWERED = { writeConcern: { w: 0 } } as const;
const UPSERT = { upsert: true, ...UNANSWERED } as const;

const MINUTE = 60_000;
const HOUR = 3_600_000;

type Receipt = {
  _id: string;
  step: string;
  at: number;
  done?: boolean;
  text?: string;
  failed?: boolean;
};

/** The longest answer a receipt keeps (characters); a longer one is shown again from its step. */
const KEPT = 8_000;
type Counter = { _id: string; until: number; most: number; say: string };

export const callAction = defineAction({
  description: "One call to one of the app's tools, from a model outside (MCP)",
  input: {
    type: "object",
    properties: {
      line: { type: "string" },
      tool: { type: "string" },
      input: { type: "object" },
      /** The call's id (`mcp:<thread>:<request>:<what>`), as the route made it. */
      call: { type: "string", maxLength: 120 },
      /**
       * Its chat, as the route found it: the contact's under one of the app's
       * secrets (else the one under its own).
       */
      thread: { type: "string", maxLength: 60 },
      /** What named its conversation: a session, a handle the app gave, or a handle just made. */
      by: { enum: ["session", "handle", "new"] },
      /** Who started it, when the client says (an HMAC of `openai/subject`): for their limit. */
      user: { type: "string", maxLength: 40 },
      /** Where it comes from, when the app's front says (an HMAC of the address): for its limits. */
      address: { type: "string", maxLength: 40 },
      /** A widget's own call (its grant checked by the route): admitted here, made there. */
      app: { type: "boolean" },
    },
    required: ["line", "tool", "input", "call", "by"],
    additionalProperties: false,
  },
  record: false,
  // Only a contact the MCP route made for this line: no other actor names a conversation here.
  // Who the user is and where they call from are in the input, never on the actor: an unrecorded
  // Action's input is in no event, and the actor is in every one its work causes.
  // A contact with no line (a web visitor) is never one, even naming none.
  allow: (actor, input) =>
    actor.kind === "contact" && typeof actor.mcp === "string" &&
    actor.mcp === (input as { line?: unknown })?.line,
  run: async (ctx, input): Promise<Called> => {
    if (input.app) return await admitted(ctx, input);
    const line = serverOf(ctx, input.line);
    const links = linksOf(ctx.resources);
    const contact = ctx.actor?.id;
    const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
    const tool = Object.hasOwn(tools, input.tool) ? tools[input.tool] : undefined;
    if (!line || !links || !contact || !tool || !Object.hasOwn(line.tools, input.tool)) {
      throw failure("not_found", "No such tool on this line.");
    }
    const readOnly = hintsOf(line, input.tool, tool).readOnly === true;
    // Its chat comes from its contact: under the app's secret, or the one before it (a
    // conversation from before the secret changed), as the route found it.
    const threads = await Promise.all(secretsOf(links).map((key) => threadOf(key, contact)));
    const thread = input.thread !== undefined && threads.includes(input.thread)
      ? input.thread
      : threads[0];
    // A tool that changes things keeps its receipt by what it asks here, whatever the request's
    // id: a model asking again under a new one, after a stop or a restart, finds it.
    const same = await sameCallOf(thread, input.tool, input.input);
    const now = Date.now();
    const { calls, chats } = countersOf(line, thread, input, now);
    const system = ctx.as();
    // What it needs to know first, read together: its chat (as the system, and as its contact,
    // who still reaches it or not), whether it's over, the counts, a receipt, an opening noted.
    const [there, reached, over, counted, receipt, noted] = await Promise.all([
      system.db.collection<Thread>("thread").findOne({ _id: thread }),
      ctx.db.collection<Thread>("thread").findOne({ _id: thread }),
      system.db.collection("mcp_closed").findOne({
        _id: { $in: [`contact:${contact}`, `thread:${thread}`] },
      }),
      system.db.collection<{ count: number }>("mcp_rate")
        .find({ _id: { $in: [...calls, ...chats].map((c) => c._id) } }),
      readOnly ? null : system.db.collection<Receipt>("mcp_receipt").findOne({ _id: same }),
      system.db.collection<{ at: number }>("mcp_opening").findOne({ _id: thread }),
    ]);
    if (over) return { text: SAID.closed, isError: true, ran: false };
    // A chat out of its contact's reach: its people took the contact out (over), unless its
    // first call was cut short before sharing it (an owner restarted): that opening goes on.
    const begun = !!there && !reached && !!noted && now - noted.at < RERUN_MS &&
      !!await system.db.collection("contact").findOne({ _id: contact });
    if (there && !reached && !begun) return { text: SAID.closed, isError: true, ran: false };
    if (!there && input.by === "handle") return { text: SAID.unknown, isError: true, ran: false };
    const fresh = !there || begun;
    const counts = new Map(counted.map((c) => [c._id, c.count]));
    const past = [...calls, ...fresh ? chats : []].find((c) => (counts.get(c._id) ?? 0) >= c.most);
    if (past) return { text: past.say, isError: true, ran: false };
    if (typeof tool.offer === "function") {
      const chat = there ?? { _id: thread, in: line.in, at: "" };
      if (!await offered(ctx, line, input.tool, chat)) {
        return { text: SAID.unoffered, isError: true, ran: false };
      }
    }

    // Done lately: answered with what it said. Begun, never done (stopped, an owner restarted):
    // run again as the same step, the same callId, told it's a retry.
    const answered = receipt?.done && now - receipt.at < RESEND_MS ? receipt : undefined;
    const cut = receipt && !receipt.done && now - receipt.at < RERUN_MS ? receipt : undefined;
    const step = cut?.step ?? `${input.call}@${now.toString(36)}`;
    // Taken: counted, and (a tool that changes things) noted before it runs, as a new
    // conversation's opening is before it's made (one cut short just after its share is done
    // now): one command.
    await system.transaction(async (tx) => {
      const rates = tx.db.collection("mcp_rate");
      for (const c of calls) {
        await rates.updateOne(
          { _id: c._id },
          { $inc: { count: 1 }, $set: { until: c.until } },
          UPSERT,
        );
      }
      if (!readOnly && !answered && !cut) {
        await tx.db.collection("mcp_receipt").replaceOne({ _id: same }, { step, at: now }, UPSERT);
      }
      const openings = tx.db.collection("mcp_opening");
      if (fresh && !answered) await openings.replaceOne({ _id: thread }, { at: now }, UPSERT);
      else if (noted && !fresh) await openings.deleteOne({ _id: thread }, UNANSWERED);
    });
    if (answered) return { ...await again(ctx, line, answered), ran: true, again: true };
    if (fresh) await opened(ctx, line, contact, thread);

    const ran = await runTool(ctx, input.tool, input.input, {
      agent: line.client,
      thread,
      trigger: step,
      callId: step,
      retry: !!cut,
    });
    // Only input that fit the tool's schema is kept as its input: anything else, as text.
    const given = ran.unchecked
      ? { unchecked: JSON.stringify(input.input).slice(0, 1_000) }
      : input.input;
    const call: Step = { id: input.call, name: input.tool, input: given, output: ran.output };
    const told = ran.error === undefined ? undefined : toldOf(ran.error);
    // What it answers, before it's written: the receipt keeps it, for the same call asked again.
    const text = told ?? await shown(ctx, line, call);
    await system.transaction(async (tx) => {
      // A try cut short after its step was written writes it again, the same; in the chat's space.
      await tx.db.collection("message").replaceOne({ _id: step }, {
        thread,
        in: there?.in ?? line.in,
        from: line.client,
        to: [],
        private: true,
        toolCalls: [call],
        at: new Date(cut?.at ?? now).toISOString(),
      }, UPSERT);
      // Done, unless it failed by accident (not a refusal it meant: those are its answer): then
      // the receipt stays begun, and the retry the model was told to make runs it again, as itself.
      if (!readOnly && (ran.error === undefined || isPublic(ran.error))) {
        await tx.db.collection("mcp_receipt").replaceOne({ _id: same }, {
          step,
          at: Date.now(),
          done: true,
          ...(text.length <= KEPT ? { text } : {}),
          ...(told ? { failed: true } : {}),
        }, UPSERT);
      }
      // A new conversation counts once it's made.
      if (fresh) {
        const rates = tx.db.collection("mcp_rate");
        for (const c of chats) {
          await rates.updateOne(
            { _id: c._id },
            { $inc: { count: 1 }, $set: { until: c.until } },
            UPSERT,
          );
        }
      }
    });
    const widget = !!line.tools[input.tool]?.widget;
    return {
      text,
      ...(told ? { isError: true as const } : {}),
      ran: true,
      ...(widget ? { output: ran.output.slice(0, OUTPUT) } : {}),
    };
  },
});

/**
 * A widget's own call, admitted or not: its conversation's chat there and its contact's (not
 * over), within the conversation's, the address's and the line's calls a minute, counted.
 */
async function admitted(
  ctx: Context,
  input: { line: string; tool: string; address?: string; user?: string; thread?: string },
): Promise<Called> {
  const line = serverOf(ctx, input.line);
  const links = linksOf(ctx.resources);
  const contact = ctx.actor?.id;
  const entry = line && Object.hasOwn(line.tools, input.tool) ? line.tools[input.tool] : undefined;
  if (!line || !links || !contact || !(input.tool === READ || (entry && appOnly(entry)))) {
    throw failure("not_found", "No such tool on this line.");
  }
  // Its chat, under whichever of the app's secrets the conversation was made with (as the route
  // found it), else the app's own.
  const threads = await Promise.all(secretsOf(links).map((key) => threadOf(key, contact)));
  const thread = input.thread !== undefined && threads.includes(input.thread)
    ? input.thread
    : threads[0];
  const now = Date.now();
  const { calls } = countersOf(line, thread, input, now);
  const system = ctx.as();
  const [there, reached, over, counted] = await Promise.all([
    system.db.collection<Thread>("thread").findOne({ _id: thread }),
    ctx.db.collection<Thread>("thread").findOne({ _id: thread }),
    system.db.collection("mcp_closed").findOne({
      _id: { $in: [`contact:${contact}`, `thread:${thread}`] },
    }),
    system.db.collection<{ count: number }>("mcp_rate")
      .find({ _id: { $in: calls.map((c) => c._id) } }),
  ]);
  if (over || (there && !reached)) return { text: SAID.closed, isError: true, ran: false };
  if (!there) return { text: SAID.unknown, isError: true, ran: false };
  const counts = new Map(counted.map((c) => [c._id, c.count]));
  const past = calls.find((c) => (counts.get(c._id) ?? 0) >= c.most);
  if (past) return { text: past.say, isError: true, ran: false };
  await system.transaction(async (tx) => {
    const rates = tx.db.collection("mcp_rate");
    for (const c of calls) {
      await rates.updateOne(
        { _id: c._id },
        { $inc: { count: 1 }, $set: { until: c.until } },
        UPSERT,
      );
    }
  });
  return { text: "", ran: false, admitted: true };
}

/** The counters a call goes by, each its window's: calls this minute, new conversations this hour. */
function countersOf(
  line: Server,
  thread: string,
  { user, address }: { user?: string; address?: string },
  now: number,
): { calls: Counter[]; chats: Counter[] } {
  const minute = Math.floor(now / MINUTE) * MINUTE;
  const hour = Math.floor(now / HOUR) * HOUR;
  const { limits } = line;
  const at = (what: string, start: number, most: number, say: string, span: number): Counter => ({
    _id: `${line.name}|${what}@${start}`,
    until: start + span,
    most,
    say,
  });
  return {
    calls: [
      at(`chat|${thread}`, minute, limits.perMinute, SAID.fast, MINUTE),
      ...(address ? [at(`ip|${address}`, minute, limits.ipPerMinute, SAID.slow, MINUTE)] : []),
      at("line", minute, limits.linePerMinute, SAID.busy, MINUTE),
    ],
    chats: [
      ...(user ? [at(`user|${user}`, hour, limits.userChatsPerHour, SAID.chats, HOUR)] : []),
      ...(address ? [at(`ipchats|${address}`, hour, limits.ipChatsPerHour, SAID.chats, HOUR)] : []),
      at("chats", hour, limits.chatsPerHour, SAID.busy, HOUR),
    ],
  };
}

/** Whether the tool offers itself to this contact, in this chat (its `offer`, read as the contact). */
async function offered(ctx: Context, line: Server, tool: string, thread: Thread): Promise<boolean> {
  const item: Offering = { tools: [tool], thread, agent: line.client };
  const names = await ctx.render("mcp:offered", item, {
    viewer: { kind: "agent", name: line.client },
  });
  return Array.isArray(names) && names.includes(tool);
}

/** What a failed call tells the caller: a public failure's message, else only that it failed. */
const toldOf = (error: unknown): string =>
  isPublic(error) && error instanceof Error && error.message
    ? error.message.slice(0, 1_000)
    : SAID.failed;

/**
 * What a call's result reads as to the app's agents, read as the contact:
 * its tool's View, never the output as it is; a View that fails, or says
 * nothing, hides it.
 */
async function shown(ctx: Context, line: Server, step: Step): Promise<string> {
  try {
    const text = await ctx.render(`tool:${step.name}`, step, {
      viewer: { kind: "agent", name: line.client },
    });
    return typeof text === "string" ? text : SAID.hidden;
  } catch (error) {
    console.error(`mcp.${line.name}: tool:${step.name} failed to show:`, (error as Error).message);
    return SAID.hidden;
  }
}

/** A call answered lately, answered again: what it said, kept, else shown again from its step. */
async function again(ctx: Context, line: Server, receipt: Receipt) {
  if (receipt.text !== undefined) {
    return { text: receipt.text, ...(receipt.failed ? { isError: true as const } : {}) };
  }
  const found = await ctx.as().db.collection<{ toolCalls?: Step[] }>("message")
    .findOne({ _id: receipt.step });
  const step = found?.toolCalls?.[0];
  return step
    ? { text: await shown(ctx, line, step) }
    : { text: SAID.failed, isError: true as const };
}

/**
 * A new conversation's contact and chat, as the system: the line's space
 * (made or kept, when the app declares it), the contact, and its chat
 * there, shared with it; then its opening, noted before, goes. Each step
 * finds what's done already and goes on: two first calls at once may both
 * try, and a first call cut short before the share (an owner restarted)
 * is asked again and does the rest.
 */
async function opened(ctx: Context, line: Server, contact: string, thread: string) {
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
  // Shared: from here, a chat out of the contact's reach is one its people took it out of.
  await system.db.collection("mcp_opening").deleteOne({ _id: thread });
}
