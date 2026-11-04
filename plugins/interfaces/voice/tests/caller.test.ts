/**
 * Who a caller is: a number isn't proof of it. Calling back goes on in the
 * same contact and chat only when Twilio verified the number (or the line
 * trusts numbers), never in a chat with another call on, and not past the
 * gap. A withheld number (Twilio's placeholders, with or without "+") or
 * one that isn't a number is a new contact each call. What's kept of a
 * caller goes when their contact or chat is erased, and calls' records after
 * the plugin's `keep` days. A line whose agent doesn't answer in its space
 * fails the call, with a short line.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import type { VoicePhone } from "../collections/phone.ts";
import {
  ACCOUNT,
  callSid,
  CARLA,
  heard,
  LINE_NUMBER,
  say,
  setup,
  until,
  VERIFIED,
} from "./setup.ts";

const over = (s: { docs<T>(c: string): Promise<T[]> }) =>
  until(async () => (await s.docs<VoiceCall>("voice_call")).every((c) => c.state === "over"));

test("a verified number calls back into the same contact and chat, until the gap", async () => {
  await setup(async (s) => {
    const first = await s.call({ from: CARLA, form: VERIFIED });
    say(first, "oi");
    await heard(first, 1);
    first.hangUp();
    await over(s);
    const second = await s.call({ from: CARLA, form: VERIFIED });
    say(second, "de novo");
    // Only what was said in this call is said: not the first call's answer again.
    assertEquals(await heard(second, 1), ["Você disse de novo."]);
    second.hangUp();
    await over(s);
    const calls = await s.docs<VoiceCall>("voice_call");
    assertEquals([calls[0].contact, calls[0].thread], [calls[1].contact, calls[1].thread]);

    // Quiet for 13 hours: the same caller, a new chat.
    await s.runtime.call("test.quiet", { thread: calls[0].thread, hours: 13 });
    (await s.call({ from: CARLA, form: VERIFIED })).hangUp();
    await over(s);
    const third = (await s.docs<VoiceCall>("voice_call"))[2];
    assertEquals(third.contact, calls[0].contact);
    assert(third.thread !== calls[0].thread);
    const [phone] = await s.docs<VoicePhone>("voice_phone");
    assertEquals([phone._id, phone.thread], [`help:${CARLA}`, third.thread]);
  }, { line: { limits: { callerPerDay: 10 } } });
});

test("a number Twilio didn't verify is a new contact each call, unless the line trusts numbers", async () => {
  await setup(async (s) => {
    for (let i = 0; i < 2; i++) {
      (await s.call({ from: CARLA })).hangUp();
      await over(s);
    }
    const calls = await s.docs<VoiceCall>("voice_call");
    assert(calls[0].contact !== calls[1].contact && calls[0].thread !== calls[1].thread);
    assertEquals(await s.docs("voice_phone"), []);
  });

  await setup(async (s) => {
    for (let i = 0; i < 2; i++) {
      (await s.call({ from: CARLA })).hangUp();
      await over(s);
    }
    const calls = await s.docs<VoiceCall>("voice_call");
    assertEquals([calls[0].contact, calls[0].thread], [calls[1].contact, calls[1].thread]);
  }, { line: { trustCallerId: true } });
});

test("a withheld number is nobody: each call a contact of its own, whatever Twilio says it is", async () => {
  await setup(async (s) => {
    // Twilio's placeholders (anonymous, unavailable, restricted), with and without "+", and no
    // number at all.
    for (
      const from of [
        "+266696687",
        "266696687",
        "+86282452253",
        "+7378742833",
        "7378742833",
        "anonymous",
      ]
    ) {
      (await s.call({ from, form: VERIFIED })).hangUp();
      await over(s);
    }
    const calls = await s.docs<VoiceCall>("voice_call");
    assertEquals(new Set(calls.map((c) => c.contact)).size, 6);
    assertEquals(new Set(calls.map((c) => c.thread)).size, 6);
    assertEquals(await s.docs("voice_phone"), []);
  }, { line: { trustCallerId: true, limits: { callerPerDay: 10 } } });
});

test("two calls at once from one number never share a chat", async () => {
  await setup(async (s) => {
    const a = await s.call({ from: CARLA, form: VERIFIED });
    const b = await s.call({ from: CARLA, form: VERIFIED });
    const [ca, cb] = await s.docs<VoiceCall>("voice_call");
    assert(ca.thread !== cb.thread);
    // What one says isn't heard on the other.
    say(a, "meu nome é ana");
    await heard(a, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assertEquals(b.said(), []);
    a.hangUp();
    b.hangUp();
  }, { line: { limits: { callerAtOnce: 2 } } });
});

test("erasing a contact, or its chat, takes what was kept of the caller with it", async () => {
  await setup(async (s) => {
    const call = await s.call({ from: CARLA, form: VERIFIED });
    say(call, "long, please");
    await until(() => call.sent.filter((m) => m.type === "text").length >= 3, 3_000, "words");
    call.tell({ type: "interrupt", utteranceUntilInterrupt: "Temos muitas" });
    await until(async () => !!(await s.docs<VoiceCall>("voice_call"))[0].cut, 5_000, "the cut");
    const [c] = await s.docs<VoiceCall>("voice_call");
    // Its chat erased: the call's record names it no more, nor keeps what was heard there.
    await s.runtime.call("chat.erase", { thread: c.thread });
    await s.runtime.idle();
    const [erased] = await s.docs<VoiceCall>("voice_call");
    assertEquals([erased.thread, erased.cut, erased.from], [undefined, undefined, CARLA]);
    assertEquals((await s.docs<VoicePhone>("voice_phone"))[0].thread, undefined);
    // Its contact erased: the number goes too.
    call.hangUp();
    await s.runtime.call("test.erase", { contact: c.contact });
    await s.runtime.idle();
    assertEquals(await s.docs("voice_phone"), []);
    const [gone] = await s.docs<VoiceCall>("voice_call");
    assertEquals([gone.from, gone.erased], [undefined, true]);
  });
});

test("calls' records go after the plugin's keep days, once they're over; a call on stays", async () => {
  await setup(async (s) => {
    (await s.call({ from: CARLA, form: VERIFIED })).hangUp();
    await over(s);
    const live = await s.call();
    const [old, on] = await s.docs<VoiceCall>("voice_call");
    await s.runtime.call("test.age", { call: old._id, ms: 31 * 86_400_000 });
    // Rung long ago (as far as its record says), but holding its place still: it's going on.
    await s.runtime.call("test.age", { call: on._id, ms: 31 * 86_400_000, held: true });
    assertEquals(await s.runtime.call("voice.prune", {}), { pruned: 1 });
    assertEquals((await s.docs<VoiceCall>("voice_call")).map((c) => c._id), [on._id]);
    live.hangUp();
  });
});

test("two calls from one number, both starting at once, never share a chat", async () => {
  await setup(async (s) => {
    (await s.call({ from: CARLA, form: VERIFIED })).hangUp();
    await over(s);
    // Two more, their sockets open, Twilio's setups told at the same moment. Each socket is
    // told its own call (rung in parallel, they may be stored in either order).
    const calls = [callSid(901), callSid(902)];
    const relays = await Promise.all(calls.map(async (call) => {
      const twiml = await (await s.ring({ from: CARLA, call, form: VERIFIED })).text();
      return (await s.open(twiml)).relay;
    }));
    for (const [i, relay] of relays.entries()) {
      relay.tell({
        type: "setup",
        accountSid: ACCOUNT,
        callSid: calls[i],
        from: CARLA,
        to: LINE_NUMBER,
        direction: "inbound",
      });
    }
    await until(async () =>
      (await s.docs<VoiceCall>("voice_call")).filter((c) => c.state === "live").length === 2
    );
    const all = await s.docs<VoiceCall>("voice_call");
    const [a, b] = calls.map((id) => all.find((c) => c._id === id)!);
    const first = all.find((c) => !calls.includes(c._id))!;
    assert(a.thread !== b.thread);
    // One of them may go on in the chat before; never both.
    assert([a.thread, b.thread].filter((t) => t === first.thread).length <= 1);
    for (const relay of relays) relay.hangUp();
  }, { line: { limits: { callerAtOnce: 2, callerPerDay: 10 } } });
});

test("a line whose agent doesn't answer in its space fails the call, with a short line", async () => {
  await setup(async (s) => {
    const { relay } = await s.open(await (await s.ring({ from: CARLA })).text());
    const [ringing] = await s.docs<VoiceCall>("voice_call");
    relay.tell({
      type: "setup",
      accountSid: ACCOUNT,
      callSid: ringing._id,
      from: CARLA,
      to: LINE_NUMBER,
      direction: "inbound",
    });
    // No other agent takes it: the caller hears only that, and Twilio is told why.
    assertEquals(await heard(relay, 1), ["Desculpe, não consegui responder agora. Pode repetir?"]);
    await until(() => relay.sent.some((m) => m.type === "end"), 5_000, "end");
    assertEquals(JSON.parse(relay.sent.at(-1)!.handoffData!), { reason: "error" });
    const chats = await s.docs<{ agents?: string[] }>("thread");
    assertEquals(chats.flatMap((t) => t.agents ?? []).includes("phone"), false);
  }, { line: { agent: "desk" } });
});
