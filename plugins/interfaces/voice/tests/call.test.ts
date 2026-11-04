/**
 * A call over the socket, with a fake ConversationRelay: the caller is a
 * contact in a chat of their own; what they say goes to the agent, and its
 * answers are said, never a step's words before its tools, nor anything of
 * a turn that offers tools while it's written (as a web visitor reads it);
 * speaking over an answer, the agent is told what was heard; a failed or too
 * slow answer says the line's short line, never the error; the agent, the
 * silence and the call's length end it; keys pressed reach the agent.
 */
import { assert, assertEquals } from "@std/assert";
import { definePlugin } from "../../../../runtime/mod.ts";
import type { Filter, FindOptions } from "../../../../runtime/store.ts";
import { matches, sortAndPage } from "../../../../runtime/mongo.ts";
import type { Message } from "../../../agents/chat/mod.ts";
import { test } from "../../../../testing/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import { callView } from "../views/call.ts";
import { ACCOUNT, CARLA, heard, LINE_NUMBER, offered, say, setup, until } from "./setup.ts";

const FAILED = "Desculpe, não consegui responder agora. Pode repetir?";
const BYE = "Vou encerrar a ligação agora. Até logo!";

test("a whole call: a contact in a chat of its own, its answers said, never a step's words", async () => {
  await setup(async (s) => {
    const call = await s.call();
    const [live] = await s.docs<VoiceCall>("voice_call");
    assertEquals([live.state, live.session, typeof live.contact], [
      "live",
      `VX${"a".repeat(32)}`,
      "string",
    ]);
    const [contact] = await s.docs<{ _id: string; via: string; in: string }>("contact");
    assertEquals([contact._id, contact.via, contact.in], [live.contact, "voice", "line"]);

    say(call, "Quero viajar amanhã");
    assertEquals(await heard(call, 1), ["Você disse quero viajar amanhã."]);
    // The turn offers tools (the call's end_call at least): said once whole, not as it's written.
    assertEquals(call.sent.filter((m) => m.type === "text").map((t) => t.last), [true]);

    // A step's words before it looks ("Um instante, vou procurar.") are its own: only the answer.
    say(call, "search a trip");
    assertEquals((await heard(call, 2)).slice(1), ["Encontrei três viagens."]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(call.said().length, 2);
    assert(!call.sent.some((m) => m.token?.includes("instante")), "a step's words were said");

    const chat = await s.messages(live.thread!);
    const theirs = chat.filter((m) => m.from === `contact:${contact._id}`).map((m) => m.text);
    assertEquals(theirs, ["Quero viajar amanhã", "search a trip"]);
    // The greeting Twilio said is in the chat, as the agent's: it knows not to greet again.
    // The step's words are in the chat, private: the agent's own working.
    assert(chat.some((m) => m.private && m.text === "Um instante, vou procurar. "));
    assertEquals(chat.filter((m) => m.from === "phone" && !m.private).map((m) => m.text), [
      "Olá! Como posso ajudar?",
      "Você disse **quero viajar amanhã**.",
      "Encontrei três viagens.",
    ]);

    call.hangUp();
    await until(async () => (await s.docs<VoiceCall>("voice_call"))[0].state === "over");
    const [over] = await s.docs<VoiceCall>("voice_call");
    assertEquals([over.reason, typeof over.seconds], ["hangup", "number"]);
  });
});

test("a turn that offers tools says nothing while it's written: its answer once whole", async () => {
  await setup(async (s) => {
    const call = await s.call();
    const asked = Date.now();
    say(call, "long, please");
    await until(() => call.sent.some((m) => m.type === "text"), 5_000, "the answer");
    const first = Date.now() - asked;
    // The model takes about 2.4 s to write it: nothing of it goes before it's whole.
    assert(first > 2_000, `first words after ${first} ms`);
    assertEquals(call.sent.filter((m) => m.type === "text").length, 1);
    assertEquals(
      call.said()[0],
      "Temos muitas viagens hoje, de manhã e à tarde. ".repeat(4).trim(),
    );
  });
});

test("speaking over an answer, the agent is told what was heard", async () => {
  await setup(async (s) => {
    const call = await s.call();
    say(call, "long, please");
    await heard(call, 1, 5_000);
    call.tell({
      type: "interrupt",
      utteranceUntilInterrupt: "Temos muitas",
      durationUntilInterruptMs: 900,
    });
    const cutAt = call.sent.length;
    await until(
      async () => {
        const [c] = await s.docs<VoiceCall>("voice_call");
        return !!c.cut;
      },
      5_000,
      "the cut",
    );
    const [c] = await s.docs<VoiceCall>("voice_call");
    const answer = (await s.messages(c.thread!)).find((m) => m._id === c.cut!.message)!;
    assert(answer.text!.startsWith("Temos muitas viagens") && answer.text!.length > 100);
    assertEquals(c.cut!.heard, "Temos muitas");
    assertEquals(call.sent.length, cutAt);

    // Its next answer knows: it was told (the scripted model says "(cut)" when it is).
    say(call, "ok");
    assertEquals((await heard(call, 2)).at(-1), "Você disse ok. (cut)");
    // Told once: the answer after that is heard whole, and nothing is said of it.
    say(call, "e agora");
    assertEquals((await heard(call, 3)).at(-1), "Você disse e agora.");
  });
});

test("a failed answer says a short line in the line's language, never the error", async () => {
  await setup(async (s) => {
    const call = await s.call();
    say(call, "please fail");
    assertEquals(await heard(call, 1), [FAILED]);
    assert(!JSON.stringify(call.sent).includes("model down"));
    assert(!JSON.stringify(call.sent).includes("went wrong"));
    // The call goes on.
    say(call, "oi");
    assertEquals((await heard(call, 2)).at(-1), "Você disse oi.");
  });
});

test("an answer slower than the line's turn is stopped, and the caller told so", async () => {
  await setup(async (s) => {
    const call = await s.call();
    say(call, "slow, please");
    assertEquals(await heard(call, 1), [FAILED]);
    const [c] = await s.docs<VoiceCall>("voice_call");
    // The turn was stopped: its late answer is never said.
    await until(async () => (await s.messages(c.thread!)).some((m) => m.stopped), 3_000, "stop");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(call.said(), [FAILED]);
  }, { line: { limits: { turn: 0.3 } } });
});

test("the agent ends the call once its goodbye is said; Twilio is told why", async () => {
  await setup(async (s) => {
    const call = await s.call();
    offered.length = 0;
    say(call, "bye");
    assertEquals(await heard(call, 1), ["Até logo!"]);
    await until(() => call.sent.some((m) => m.type === "end"), 3_000, "end");
    const end = call.sent.find((m) => m.type === "end")!;
    assertEquals(JSON.parse(end.handoffData!), { reason: "agent" });
    // After `end`, Twilio closes the socket (here, the fake does when asked).
    call.hangUp();
    await until(async () => (await s.docs<VoiceCall>("voice_call"))[0].state === "over");
    const [over] = await s.docs<VoiceCall>("voice_call");
    assertEquals(over.reason, "agent");
    // It was offered while the call went on (the agent doesn't list it), and only then.
    assertEquals(offered[0], ["end_call", "search"]);
    offered.length = 0;
    await s.runtime.call("chat.send", { thread: over.thread, text: "still there?" }, {
      actor: { kind: "contact", id: over.contact! },
    });
    await s.runtime.idle();
    assertEquals(offered, [["search"]]);
  });
});

test("silence, and a call too long, end it with a goodbye", async () => {
  await setup(async (s) => {
    const call = await s.call();
    assertEquals(await heard(call, 1, 2_000), [BYE]);
    await until(() => call.sent.some((m) => m.type === "end"), 5_000, "end");
    assertEquals(JSON.parse(call.sent.at(-1)!.handoffData!), { reason: "idle" });
    // What the caller says once it's ending goes nowhere.
    say(call, "espera");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(call.said(), [BYE]);
  }, { line: { limits: { idle: 0.2 } } });

  await setup(async (s) => {
    const call = await s.call();
    say(call, "oi");
    await heard(call, 1);
    assertEquals((await heard(call, 2, 3_000)).at(-1), BYE);
    await until(() => call.sent.some((m) => m.type === "end"), 5_000, "end");
    assertEquals(JSON.parse(call.sent.at(-1)!.handoffData!), { reason: "limit" });
  }, { line: { limits: { call: 0.8 } } });
});

test("keys pressed reach the agent, a pause or # ending them, with the line's keys on", async () => {
  await setup(async (s) => {
    const twiml = await (await s.ring({ from: "+5531988887777" })).text();
    assert(twiml.includes('dtmfDetection="true"'));
    const call = await s.call();
    for (const digit of ["1", "2", "3"]) call.tell({ type: "dtmf", digit });
    assertEquals(await heard(call, 1), ["Você disse 123."]);
    call.tell({ type: "dtmf", digit: "9" });
    call.tell({ type: "dtmf", digit: "#" });
    assertEquals((await heard(call, 2)).at(-1), "Você disse 9.");
    const live = (await s.docs<VoiceCall>("voice_call")).find((x) => x._id === call.id)!;
    const typed = (await s.messages(live.thread!)).filter((m) => m.tap);
    assertEquals(typed.map((m) => [m.text, m.tap!.id]), [["123", "keys:123"], ["9", "keys:9"]]);
  }, { line: { keys: true } });

  // Without the line's keys, they're nothing.
  await setup(async (s) => {
    const call = await s.call();
    call.tell({ type: "dtmf", digit: "1" });
    call.tell({ type: "dtmf", digit: "#" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(call.said(), []);
  });
});

test("only what the caller may read is said", async () => {
  await setup(async (s) => {
    const call = await s.call();
    const [c] = await s.docs<VoiceCall>("voice_call");
    await s.runtime.call("test.said", {
      thread: c.thread,
      contact: c.contact,
      text: "Segredo",
      sources: ["elsewhere"],
    });
    await s.runtime.call("test.said", {
      thread: c.thread,
      contact: c.contact,
      text: "Olá de novo",
    });
    assertEquals(await heard(call, 1), ["Olá de novo"]);
  }, { plugins: [quiet] });
});

test("a call's setup names the call: numbers and account, as the webhook had them", async () => {
  await setup(async (s) => {
    const twiml = await (await s.ring({ from: CARLA })).text();
    const { relay } = await s.open(twiml);
    // Before setup, nothing counts.
    say(relay, "oi");
    relay.tell({
      type: "setup",
      accountSid: ACCOUNT,
      callSid: (await s.docs<VoiceCall>("voice_call"))[0]._id,
      from: CARLA,
      to: LINE_NUMBER,
      direction: "inbound",
    });
    await until(async () => (await s.docs<VoiceCall>("voice_call"))[0].state === "live");
    say(relay, "agora sim");
    assertEquals(await heard(relay, 1), ["Você disse agora sim."]);
  });
});

/** Test hands: an agent's message written as trusted code does. */
const quiet = definePlugin({
  name: "quiet",
  actions: {
    "test.said": {
      input: { type: "object" },
      run: async (
        ctx,
        input: { thread: string; contact: string; text: string; sources?: string[] },
      ) => {
        // As trusted code says something to them (`chat.say`): no turn.
        await ctx.db.collection<Message>("message").insertOne({
          _id: crypto.randomUUID(),
          thread: input.thread,
          in: "line",
          from: "phone",
          to: [`contact:${input.contact}`],
          text: input.text,
          hops: 1,
          ...(input.sources ? { sources: input.sources } : {}),
          at: new Date().toISOString(),
        });
      },
    },
  },
});

/** The call's View over these documents, read as given (the rules aside): what it would say. */
function sayingOf(docs: Record<string, Record<string, unknown>[]>) {
  const db = {
    collection: (name: string) => ({
      find: (filter: Filter, options?: FindOptions) => ({
        value: sortAndPage((docs[name] ?? []).filter((d) => matches(d, filter)), options),
      }),
      findOne: (filter: Filter) => ({
        value: (docs[name] ?? []).find((d) => matches(d, filter)) ?? null,
      }),
    }),
  };
  const ctx = { db, show: (_kind: string, m: { text?: string }) => m.text ?? "" };
  return callView(
    { _id: "CA1", thread: "t1", contact: "carla", since: "2026-01-01T00:00:00.000Z" },
    ctx as unknown as Parameters<typeof callView>[1],
  );
}

test("what a call says is what a web visitor reads: answers, and words being written only with no tools", () => {
  const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
  const message = [
    { _id: "m1", thread: "t1", from: "contact:carla", to: ["phone"], text: "oi", at: at(1) },
    // A step's words before its tools: the agent's own working, never said.
    {
      _id: "s1",
      thread: "t1",
      from: "phone",
      turn: "m1:phone",
      private: true,
      text: "Checking the supplier sheet (cost 41.20 EUR)…",
      toolCalls: [{ id: "c1", name: "search", input: {}, output: "x" }],
      at: at(2),
    },
    {
      _id: "a1",
      thread: "t1",
      from: "phone",
      to: ["contact:carla"],
      turn: "m1:phone",
      replyTo: "m1",
      text: "Encontrei três viagens.",
      at: at(3),
    },
  ];
  const live = (more: Record<string, unknown>) => ({
    _id: "m2:phone",
    thread: "t1",
    agent: "phone",
    turn: "m2:phone",
    text: "Temos muitas ",
    calls: [],
    at: at(4),
    ...more,
  });
  // A turn that offers tools: its answer is said, its step isn't, and nothing while it writes.
  const tooled = sayingOf({ message, live: [live({})] });
  assertEquals(tooled.said.map((s) => s.text), ["Encontrei três viagens."]);
  assertEquals(tooled.live, { turn: "m2:phone", text: "" });
  // One that offers none (`open`): every step is an answer, its words said as they come.
  assertEquals(sayingOf({ message, live: [live({ open: true })] }).live, {
    turn: "m2:phone",
    text: "Temos muitas ",
  });
  // Not once it calls a tool, nor a retry's reason (the provider's own).
  const calling = live({ open: true, calls: [{ id: "c2", name: "search" }] });
  assertEquals(sayingOf({ message, live: [calling] }).live!.text, "");
  const broke = live({ open: true, retry: { attempt: 1, at: at(5), reason: "429 sk-proj-…" } });
  assertEquals(sayingOf({ message, live: [broke] }).live!.text, "");
});
