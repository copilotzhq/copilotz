/** An agent's turn: model calls and tool steps until it answers, or waits for replies. */
import {
  type Context,
  type Event,
  principalOf,
  type ProcessorDef,
} from "../../../../runtime/mod.ts";
import type {
  LlmChunk,
  LlmMessage,
  LlmState,
  ModelRef,
  ToolCall,
} from "../../../models/contract.ts";
import type { Intent, Question } from "../collections/intent.ts";
import type { Message } from "../collections/message.ts";
import type { Thread } from "../collections/thread.ts";
import {
  type AgentModel,
  agentsNamed,
  modelOf,
  NO_ANSWER,
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
import { runTool, toolText } from "../shared/tools.ts";
import {
  type Agent,
  type Prompt,
  settingsOf,
  type Step,
  type Tool,
  type Turn,
} from "../shared/types.ts";

/** Runs a turn: started by `turn.requested`, or resumed when its wait is over. */
/**
 * A turn someone started (a person, or a contact in its chat) acts as its
 * agent, for them: with the access plugin, it reaches only what both reach
 * (an agent is a member of spaces, like a person). Without anyone, it runs
 * as the system.
 */
const asAgent = (ctx: Context, agent: string, at?: string): Context => {
  const principal = principalOf(ctx.actor);
  return principal
    ? ctx.as({ kind: "agent", id: agent, for: principal, ...(at ? { at } : {}) })
    : ctx;
};

/** The space a thread is in, where its turns work: what they write elsewhere needs a person. */
const spaceOf = async (ctx: Context, thread: string) =>
  (await ctx.as().db.collection<Thread>("thread").findOne({ _id: thread }))?.in;

/**
 * The model it thinks with this turn: what the `agentModel` resource says for
 * it in this space, when one says anything, else its own.
 */
async function modelFor(ctx: Context, name: string, agent: Agent, space?: string) {
  const [source] = Object.values((ctx.resources.agentModel ?? {}) as Record<string, AgentModel>);
  if (!source) return modelOf(agent);
  const chosen = await ctx.call<ModelRef | null>(source.action, {
    agent: name,
    ...(space ? { space } : {}),
  });
  return chosen ?? modelOf(agent);
}

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
    const at = principalOf(ctx.actor) ? await spaceOf(ctx, thread) : undefined;
    return await turn(asAgent(ctx, agent, at), event);
  },
};

/** One run of an agent's turn: started by `turn.requested`, or resumed when its wait is over. */
const turn = async (ctx: Context, event: Event) => {
  const t = turnOf(event);
  const run = event.id;
  // What it is: the app's, or one people made that works where this thread is.
  const agent = (await agentsNamed(ctx, [t.agent]))[t.agent];
  if (!agent) throw new Error(`No agent "${t.agent}" works here`);
  const messages = ctx.db.collection<Message>("message");
  const intents = ctx.db.collection<Intent>("intent");

  // A retried run continues after the steps it committed, if it didn't finish,
  // and goes on with the step it was taking if that step's calls were written.
  let step = 0;
  let open: Intent | null = null;
  if (ctx.retry) {
    const [done, waiting, taking] = await Promise.all([
      messages.find({ turn: run }),
      ctx.db.collection("wait").findOne({ _id: `${run}:wait` }),
      intents.findOne({ _id: run }),
    ]);
    if (done.some((m) => m._id === `${run}:reply`) || waiting) return;
    step = done.length;
    if (taking?.step === step) open = taking;
  }
  // Resumed once the questions its tools asked were answered: the calls that asked run again
  // first, as themselves, in a step of their own after the answers.
  let fresh = false;
  if (event.type === "wait.updated" && t.step && step === 0 && !open) {
    open = await again(ctx, t, run);
    fresh = !!open;
  }

  // What it is sent is the thread's llm View: its instructions, the
  // conversation, and what contexts add.
  const viewer = { kind: "agent", name: t.agent };
  const current = await ctx.db.collection<Thread>("thread").findOne({ _id: t.thread }) ??
    { _id: t.thread, at: "" };
  // A person's messages in a row are answered together, by the turn that read
  // them: a later one's own turn, with nothing of it written yet, has nothing to add.
  if (
    event.type === "turn.requested" && t.hops === 0 && step === 0 && !open &&
    current.latest !== t.trigger && await answered(ctx, t)
  ) return;
  const composed = await ctx.render("llm.thread", current, { viewer }) as Prompt;
  const instructions = composed.system.join("\n\n");
  // The conversation up to here repeats in the next calls: a cache point, before what's new each turn.
  const history = composed.history.map((m, i, all) =>
    i === all.length - 1 ? { ...m, cache: true as const } : m
  );
  // What's new this turn, after it; kept on the turn's first message, to be sent there again.
  const told = composed.turn;
  const conversation: LlmMessage[] = [
    ...history,
    ...(told.length ? [{ role: "user" as const, text: told.map((c) => c.text).join("\n\n") }] : []),
  ];
  const first = step;
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

  // What it writes shows as it comes: the turn's live document. Offered no tools (or only those
  // called beside an answer, `aside`), every step is an answer: a contact may read its words as
  // they come too.
  const tools = (ctx.resources.tools ?? {}) as Record<string, Tool>;
  const live = liveWriter(
    ctx,
    t,
    run,
    current.in,
    offered.every((tool) => tools[tool.name]?.aside === true),
  );
  // Asked once a run: a change reaches its next reply, never a step halfway.
  const model = await modelFor(ctx, t.agent, agent, current.in);

  const { maxSteps } = settingsOf(ctx);
  for (; maxSteps === undefined || step < maxSteps; step++) {
    live.begin();
    let text = "";
    let state: LlmState | undefined;
    const calls: ToolCall[] = [];
    // A step whose calls were written goes on with them: its model isn't asked again.
    const resumed = open;
    open = null;
    const ask = (input: Record<string, unknown>) =>
      resumed ? replay(resumed) : ctx.call<AsyncIterable<LlmChunk>>("llm.stream", input);
    for await (
      const chunk of await ask({
        model,
        instructions,
        messages: conversation,
        tools: offered,
        // Its usage record says whose turn it was, in which thread and space.
        tags: {
          thread: t.thread,
          agent: t.agent,
          turn: run,
          ...(current.in ? { space: current.in } : {}),
        },
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
      // Its answer keeps what it was told, and its state: what it thought goes back with it.
      // And how far it had read the thread: what came after, it reads after this answer.
      return await answer(ctx, t, run, text, {
        ...(step === first ? { told } : {}),
        ...(state ? { state } : {}),
        ...(current.at ? { knew: current.at } : {}),
      }, current);
    }

    // Ids derive from the run, so a retry rewrites nothing it already committed.
    const id = `${run}:${step}`;
    const at = resumed?.at ?? now(); // The step comes before what it sends.
    // The turn's first message keeps what it was told.
    const kept = told.length && step === first ? { told } : {};
    // Before any of its calls runs, the step is written, so a retry runs these
    // same calls rather than ask again. Messages need none: they go with the step.
    const intended = !!resumed || calls.some((call) => !(messaging && call.name === SEND));
    if (intended && !resumed) {
      await intents.replaceOne({ _id: run }, {
        thread: t.thread,
        agent: t.agent,
        step,
        ...(text ? { text } : {}),
        ...(state ? { state } : {}),
        ...kept,
        calls,
        outputs: {},
        at,
      }, { upsert: true });
    }
    // The step's calls run together, each in a branch of its own, so a retry
    // finds what each one called whatever order they started in. Their
    // results keep the model's order.
    // What its calls ask as they run (a person's yes), each its own question: those of a call
    // that returned before a retry are on its intent.
    const asks: Record<number, Question> = { ...resumed?.asks };
    const questionOf = (i: number) => `${id}:${i}:question`;
    const ran = await Promise.all(calls.map(async (call, i) => {
      live.call({ id: call.id, name: call.name, input: call.input });
      let output: string;
      let send: Send | undefined;
      const returned = resumed?.outputs[i];
      // A call run again once its question was answered: as itself, told the answer.
      const answering = resumed?.again?.[i];
      if (messaging && call.name === SEND) {
        send = await prepare(ctx, t, id, `${id}:${i}`, call.input, here, known, current.in);
        output = send.output;
      } else if (returned !== undefined) {
        // It returned before the retry: it doesn't run again.
        output = returned;
      } else {
        // Only a tool offered to it here; each in a branch of its own, as chat's runner runs them.
        output = offered.some((tool) => tool.name === call.name)
          ? (await runTool(ctx.branch(`${step}.${i}`), call.name, call.input, {
            agent: t.agent,
            thread: t.thread,
            trigger: t.trigger,
            callId: answering?.call ?? `${id}:${i}`,
            // Only a call that was written and never returned may have run already.
            retry: !!resumed && !(fresh && answering),
            ask: (question) => {
              asks[i] = { to: question.to, text: question.text };
              return questionOf(i);
            },
            ...(answering ? { answer: await answerTo(ctx, answering.question) } : {}),
          })).output
          : `Error: Unknown tool "${call.name}"`;
        // What it returned (and asked) is on record at once: a retry won't run it again. If
        // that write fails, a retry runs it again, as itself.
        await intents.updateOne({ _id: run }, {
          $set: { [`outputs.${i}`]: output, ...(asks[i] ? { [`asks.${i}`]: asks[i] } : {}) },
        }).catch(() => {});
      }
      live.result(call.id, output);
      const made: Step = {
        ...call,
        output,
        ...(send?.message ? { sent: send.message._id } : {}),
        ...(asks[i] ? { asked: questionOf(i) } : {}),
      };
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
      conversation.push({ role: "tool", toolCallId: c.id, text: await toolText(ctx, c, viewer) });
    }

    // What its tools asked: each the agent's message to whom it asks, a reply to which they wait for.
    const questions = Object.entries(asks).map(([i, q]) => ({
      _id: questionOf(Number(i)),
      thread: t.thread,
      ...(current.in ? { in: current.in } : {}),
      from: t.agent,
      to: [q.to],
      text: q.text,
      hops: t.hops + 1,
      at: now(),
    }));
    // The step, what it sent and asked, and what it waits for commit together, so no
    // reply can arrive before the wait it checks off.
    const waitingFor = [
      ...sends.filter((s) => s.message!.expectReply !== false).map((s) => s.message!._id),
      ...questions.map((q) => q._id),
    ];
    // Handing work to another space is trusted code's: the agent doesn't work there.
    const writer = sends.some((s) => s.across) ? ctx.as() : ctx;
    const deliveries = await Promise.all(
      sends.map((s) => delivery(writer, s.message!, s.message!.subthread)),
    );
    await live.settle();
    await writer.transaction(async (tx) => {
      // What showed live becomes the step, and so does what was written of it.
      await live.done(tx);
      if (intended) await tx.db.collection("intent").deleteOne({ _id: run }, NO_ANSWER);
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
        ...kept,
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
      for (const question of questions) {
        await noted(tx, question);
        await tx.db.collection("message").insertOne(question);
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
          ...(questions.length ? { step: id } : {}),
          at: now(),
        });
      }
    });
    if (waitingFor.length) return;
  }
  throw new Error(`Agent "${t.agent}" did not finish within ${maxSteps} steps`);
};

/**
 * Whether the person's message that started a turn is answered already: its
 * agent's latest answer here had read it (`knew`), and went to them.
 */
async function answered(ctx: Context, t: Turn): Promise<boolean> {
  const messages = ctx.db.collection<Message>("message");
  const [trigger, [latest]] = await Promise.all([
    messages.findOne({ _id: t.trigger }),
    messages.find(
      { thread: t.thread, from: t.agent, knew: { $exists: true } },
      { sort: { at: -1 }, limit: 1 },
    ),
  ]);
  return !!trigger && !!latest?.knew && latest.knew >= trigger.at &&
    latest.to.includes(trigger.from);
}

/**
 * The step a turn resumes with once the questions its tools asked were
 * answered: each call that asked, run again as itself (its own `callId`),
 * after the answers; nothing of the paused step is rewritten. None when the
 * step asked nothing.
 */
async function again(ctx: Context, t: Turn, run: string): Promise<Intent | null> {
  const paused = await ctx.db.collection<Message>("message").findOne({ _id: t.step });
  const asked = ((paused?.toolCalls ?? []) as Step[]).flatMap((c, i) =>
    c.asked ? [{ ...c, call: `${t.step}:${i}` }] : []
  );
  if (!asked.length) return null;
  const intent: Intent = {
    thread: t.thread,
    agent: t.agent,
    step: 0,
    calls: asked.map(({ id, name, input }) => ({ id: `${id}:answered`, name, input })),
    outputs: {},
    again: Object.fromEntries(asked.map((c, i) => [i, { call: c.call, question: c.asked! }])),
    at: now(),
  };
  await ctx.db.collection("intent").replaceOne({ _id: run }, intent, { upsert: true });
  return intent;
}

/** The answer to a question a tool asked: who answered, and what they said. */
async function answerTo(ctx: Context, question: string) {
  const [reply] = await ctx.db.collection<Message>("message").find(
    { replyTo: question },
    { sort: { at: 1 }, limit: 1 },
  );
  return { from: reply?.from ?? "", text: reply?.text ?? "" };
}

/** What a written step's model said, said again: what it wrote, its state and its calls. */
async function* replay(intent: Intent): AsyncIterable<LlmChunk> {
  if (intent.text) yield { type: "text", text: intent.text };
  if (intent.state) yield { type: "state", state: intent.state };
  for (const call of intent.calls) yield { type: "tool_call", call };
}
