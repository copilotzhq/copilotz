/** An agent's turn: model calls and tool steps until it answers, or waits for replies. */
import type { Context, Event, ProcessorDef } from "../../../../runtime/mod.ts";
import type { LlmChunk, LlmMessage, LlmState, ToolCall } from "../../../models/contract.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import {
  agentsNamed,
  check,
  modelOf,
  now,
  peopleIn,
  SEND,
  type Team,
  teamOf,
  turnOf,
} from "../shared/agents.ts";
import { answer, delivery } from "../shared/delivery.ts";
import { liveWriter } from "../shared/live.ts";
import { prepare, type Send } from "../shared/send.ts";
import { noted, startedWith } from "../shared/summary.ts";
import { type Prompt, settingsOf, type Step, type Tool } from "../shared/types.ts";

/** Runs a turn: started by `turn.requested`, or resumed when its wait is over. */
/**
 * A turn someone started acts as its agent, for them: with the access
 * plugin, it reaches only what both reach (an agent is a member of spaces,
 * like a person). Without anyone, it runs as the system.
 */
const asAgent = (ctx: Context, agent: string, at?: string): Context =>
  ctx.actor?.kind === "person"
    ? ctx.as({ kind: "agent", id: agent, for: ctx.actor, ...(at ? { at } : {}) })
    : ctx;

/** The space a thread is in, where its turns work: what they write elsewhere needs a person. */
const spaceOf = async (ctx: Context, thread: string) =>
  (await ctx.as().db.collection<Thread>("thread").findOne({ _id: thread }))?.in;

export const turnProcessor: ProcessorDef = {
  on: ["turn.requested", "wait.updated"],
  // A turn requested, or a wait whose last reply just came in.
  where: {
    $or: [
      { agent: { $exists: true } },
      { changed: "waitingFor", "doc.waitingFor.0": { $exists: false } },
    ],
  },
  key: (event) => `${turnOf(event).thread}:${turnOf(event).agent}`,
  run: async (ctx, event) => {
    const { agent, thread } = turnOf(event);
    // Only someone's turn needs to know where it works.
    const at = ctx.actor?.kind === "person" ? await spaceOf(ctx, thread) : undefined;
    return await turn(asAgent(ctx, agent, at), event);
  },
};

/** One run of an agent's turn: started by `turn.requested`, or resumed when its wait is over. */
const turn = async (ctx: Context, event: Event) => {
  const t = turnOf(event);
  const run = event.id;
  const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
  // What it is: the app's, or one people made that works where this thread is.
  const agent = (await agentsNamed(ctx, [t.agent]))[t.agent];
  if (!agent) throw new Error(`No agent "${t.agent}" works here`);
  const messages = ctx.db.collection<Message>("message");

  // A retried run continues after the steps it committed, if it didn't finish.
  let step = 0;
  if (ctx.retry) {
    const done = await messages.find({ turn: run });
    if (done.some((m) => m._id === `${run}:reply`)) return;
    if (await ctx.db.collection("wait").findOne({ _id: `${run}:wait` })) return;
    step = done.length;
  }

  // What it is sent is the thread's llm View: its instructions, the
  // conversation, and what contexts add.
  const viewer = { kind: "agent", name: t.agent };
  const current = await ctx.db.collection<Thread>("thread").findOne({ _id: t.thread }) ??
    { _id: t.thread, at: "" };
  const composed = await ctx.render("llm", "thread", current, { viewer }) as Prompt;
  const instructions = composed.system.join("\n\n");
  // The conversation up to here repeats in the next calls: a cache point, before what's new each turn.
  const history = composed.history.map((m, i, all) =>
    i === all.length - 1 ? { ...m, cache: true as const } : m
  );
  const conversation: LlmMessage[] = [
    ...history,
    ...(composed.turn.length ? [{ role: "user" as const, text: composed.turn.join("\n\n") }] : []),
  ];
  const offered = composed.tools;
  const messaging = (agent.tools ?? []).includes(SEND);
  // Whom it may message, read only when it messages someone: the agents
  // working in this thread's space, and the people it has seen here.
  let team: Promise<Team> | undefined;
  const here = () => team ??= teamOf(ctx, current.in);
  let people: Promise<Set<string>> | undefined;
  const known = () =>
    people ??= messages.query<Message[]>("visible", { thread: t.thread, agent: t.agent })
      .then(async (seen) => {
        const named = await agentsNamed(ctx, seen.flatMap((m) => [m.from, ...m.to]));
        return new Set(peopleIn(seen, named));
      });

  // What it writes shows as it comes: the turn's live document.
  const live = liveWriter(ctx, t, run, current.in);

  const { maxSteps } = settingsOf(ctx);
  for (; maxSteps === undefined || step < maxSteps; step++) {
    live.begin();
    let text = "";
    let state: LlmState | undefined;
    const calls: ToolCall[] = [];
    for await (
      const chunk of await ctx.call<AsyncIterable<LlmChunk>>("llm.stream", {
        model: modelOf(agent),
        instructions,
        messages: conversation,
        tools: offered,
        // Its usage record says whose turn it was, in which thread.
        tags: { thread: t.thread, agent: t.agent, turn: run },
      })
    ) {
      if (chunk.type === "text") {
        text += chunk.text;
        live.text(chunk.text);
      } else if (chunk.type === "tool_call") calls.push(chunk.call);
      else if (chunk.type === "state") state = chunk.state;
      else if (chunk.type === "retry") {
        // The call broke: the step starts over once it's tried again; meanwhile its live text says so.
        text = "";
        calls.length = 0;
        state = undefined;
        live.retry(chunk);
      }
    }
    if (!calls.length) {
      await live.settle();
      return await answer(ctx, t, run, text, {}, current);
    }

    // Ids derive from the run, so a retry rewrites nothing it already committed.
    const id = `${run}:${step}`;
    const at = now(); // The step comes before what it sends.
    // The step's calls run together, each in a branch of its own, so a retry
    // finds what each one called whatever order they started in. Their
    // results keep the model's order.
    const ran = await Promise.all(calls.map(async (call, i) => {
      live.call({ id: call.id, name: call.name, input: call.input });
      let output: string;
      let send: Send | undefined;
      if (messaging && call.name === SEND) {
        send = await prepare(ctx, t, id, `${id}:${i}`, call.input, here, known, current.in);
        output = send.output;
      } else {
        try {
          if (!offered.some((tool) => tool.name === call.name)) {
            throw new Error(`Unknown tool "${call.name}"`);
          }
          check(call.name, tools[call.name])(call.input);
          const result = await tools[call.name].run(call.input, {
            ...ctx.branch(`${step}.${i}`),
            agent: t.agent,
            thread: t.thread,
            trigger: t.trigger,
          });
          output = typeof result === "string" ? result : JSON.stringify(result);
        } catch (error) {
          output = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      live.result(call.id, output);
      const made: Step = { ...call, output, ...(send?.message ? { sent: send.message._id } : {}) };
      return { made, send };
    }));
    const done = ran.map((r) => r.made);
    const sends = ran.flatMap((r) => r.send?.message ? [r.send] : []);
    conversation.push({
      role: "assistant",
      toolCalls: calls,
      text: text || undefined,
      ...(state ? { state } : {}),
    });
    for (const c of done) {
      // As later turns will see it, through its tool's View.
      const shown = await ctx.render("llm", `tool:${c.name}`, c, { viewer });
      conversation.push({
        role: "tool",
        toolCallId: c.id,
        text: typeof shown === "string" ? shown : c.output,
      });
    }

    // The step, what it sent and what it waits for commit together, so no
    // reply can arrive before the wait it checks off.
    const waitingFor = sends.filter((s) => s.message!.expectReply !== false)
      .map((s) => s.message!._id);
    const deliveries = await Promise.all(
      sends.map((s) => delivery(ctx, s.message!, s.message!.subthread)),
    );
    await live.settle();
    await ctx.transaction(async (tx) => {
      // What showed live becomes the step.
      await live.done(tx);
      const step = {
        _id: id,
        thread: t.thread,
        ...(current.in ? { in: current.in } : {}),
        from: t.agent,
        to: [],
        private: true,
        ...(text ? { text } : {}),
        toolCalls: done,
        ...(state ? { state } : {}),
        turn: run,
        at,
      };
      await tx.db.collection("message").insertOne(step);
      for (const [i, send] of sends.entries()) {
        // A new thread starts with its message's summary; an existing one moves.
        if (send.thread) {
          await tx.db.collection("thread").insertOne({
            ...send.thread,
            ...startedWith(send.message!),
          });
        } else await noted(tx, send.message!);
        await tx.db.collection("message").insertOne(send.message!);
        await deliveries[i](tx);
      }
      if (waitingFor.length) {
        await tx.db.collection("wait").insertOne({
          _id: `${run}:wait`,
          agent: t.agent,
          thread: t.thread,
          trigger: t.trigger,
          hops: t.hops,
          waitingFor,
          received: [],
          at: now(),
        });
      }
    });
    if (waitingFor.length) return;
  }
  throw new Error(`Agent "${t.agent}" did not finish within ${maxSteps} steps`);
};
