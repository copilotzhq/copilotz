/**
 * What a call may cost, and say: only the turns the caller's own words
 * started are said (a staff member's in their chat isn't); a new prompt
 * stops the turn still answering the one before, so one turn runs at a
 * time; a call takes so many prompts, an answer says so many characters; a
 * call that ends stops its turn, and one that starts after it; the goodbye
 * waits 15 seconds at most; a call holds its place until its hard end; and
 * frames that aren't Twilio's messages change nothing.
 */
import { assert, assertEquals } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import type { VoiceCall } from "../collections/call.ts";
import { goodbyeWait } from "../routes/relay.ts";
import { GOODBYE_MS, lastsMs, LIMITS } from "../shared/settings.ts";
import { heard, say, setup, until } from "./setup.ts";

const BYE = "Vou encerrar a ligação agora. Até logo!";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a staff member's turn in the caller's chat isn't said to the caller", async () => {
  await setup(async (s) => {
    const call = await s.call();
    const [c] = await s.docs<VoiceCall>("voice_call");
    await s.runtime.call("test.member", { person: "staff1", role: "editor" });
    // A staff member asks the agent there: a step's words, then an answer, all for them.
    await s.runtime.call("chat.send", {
      thread: c.thread,
      text: "search, then an internal note: do not refund this customer",
    }, { actor: { kind: "person", id: "staff1" } });
    await s.runtime.idle();
    const written = (await s.messages(c.thread!)).filter((m) => m.from === "phone" && m.turn);
    assert(written.some((m) => m.private) && written.some((m) => !m.private), "it answered");
    assertEquals(call.said(), []);
    // The caller's own words are still answered, and said.
    say(call, "oi");
    assertEquals(await heard(call, 1), ["Você disse oi."]);
  });
});

test("a new prompt stops the turn still answering the one before: one turn at a time", async () => {
  await setup(async (s) => {
    const call = await s.call();
    say(call, "slow, please");
    await sleep(100);
    say(call, "oi");
    assertEquals(await heard(call, 1), ["Você disse oi."]);
    const [c] = await s.docs<VoiceCall>("voice_call");
    await s.runtime.idle();
    const answers = (await s.messages(c.thread!)).filter((m) =>
      m.from === "phone" && m.turn &&
      !m.private
    );
    assertEquals(answers.map((m) => !!m.stopped), [true, false]);
    await sleep(1_600);
    assertEquals(call.said(), ["Você disse oi."]);
  });
});

test("a call takes so many prompts: past them, a goodbye and the end", async () => {
  await setup(async (s) => {
    const call = await s.call();
    say(call, "um");
    await heard(call, 1);
    say(call, "dois");
    await heard(call, 2);
    say(call, "três");
    assertEquals((await heard(call, 3)).at(-1), BYE);
    await until(() => call.sent.some((m) => m.type === "end"), 5_000, "end");
    assertEquals(JSON.parse(call.sent.at(-1)!.handoffData!), { reason: "turns" });
    const [c] = await s.docs<VoiceCall>("voice_call");
    const theirs = (await s.messages(c.thread!)).filter((m) => m.from === `contact:${c.contact}`);
    assertEquals(theirs.map((m) => m.text), ["um", "dois"]);
  }, { line: { limits: { turns: 2 } } });
});

test("an answer says so many characters at most: cut at a word", async () => {
  await setup(async (s) => {
    const call = await s.call();
    say(call, "long, please");
    await heard(call, 1, 5_000);
    const [said] = call.said();
    const whole = "Temos muitas viagens hoje, de manhã e à tarde. ".repeat(4);
    assert(said.length <= 60 && whole.startsWith(said) && said.endsWith(" "), `"${said}"`);
    await sleep(200);
    assertEquals(call.said().length, 1);
    // The call goes on.
    say(call, "oi");
    assertEquals((await heard(call, 2)).at(-1), "Você disse oi.");
  }, { line: { limits: { said: 60 } } });
});

test("a call that ends stops its turn, and no turn of it runs after", async () => {
  await setup(async (s) => {
    const call = await s.call();
    const [c] = await s.docs<VoiceCall>("voice_call");
    for (let i = 0; i < 4; i++) say(call, `slow ${i}`);
    await sleep(300);
    call.hangUp();
    const ended = new Date().toISOString();
    await until(async () => (await s.docs<VoiceCall>("voice_call"))[0].state === "over");
    // Past the scripted model's slow answer, and the drain.
    await sleep(2_500);
    await s.runtime.idle();
    const after = (await s.messages(c.thread!)).filter((m) =>
      m.from === "phone" && m.turn && m.at > ended && !m.stopped
    );
    assertEquals(after.map((m) => m.text), []);
    // Each prompt stopped the turn before it: at most one ran at a time.
    const theirs = (await s.messages(c.thread!)).filter((m) => m.from === `contact:${c.contact}`);
    assert(theirs.length >= 1 && theirs.length <= 4);
  });
});

test("the goodbye waits for what's being said, 15 seconds at most; a call ends by its hard end", async () => {
  const now = 1_000_000;
  assertEquals(goodbyeWait(now, now), 250);
  assertEquals(goodbyeWait(now + 3_000, now), 3_250);
  assertEquals(goodbyeWait(now + 600_000, now), GOODBYE_MS + 250);
  // Its limit, the goodbye's longest wait, and closing: 10 minutes and 20 seconds.
  assertEquals(lastsMs({ limits: LIMITS }), 620_000);

  await setup(async (s) => {
    const call = await s.call();
    const [c] = await s.docs<VoiceCall>("voice_call");
    // Its place among the line's calls at once is held until then, and a little.
    const held = Date.parse(c.until) - Date.parse(c.started!);
    assert(held >= 20_500 && held < 27_000, `${held}`);
    // Past the goodbye's wait (here, nothing being said), the call ends: Twilio is told.
    await until(() => call.sent.some((m) => m.type === "end"), 5_000, "end");
  }, { line: { limits: { call: 0.5 } } });
});

test("frames that aren't Twilio's messages change nothing", async () => {
  await setup(async (s) => {
    const call = await s.call();
    for (const data of ["null", "42", "[]", '"prompt"', "{", "x".repeat(20_000)]) {
      call.raw(data);
    }
    call.raw(new Uint8Array([1, 2, 3]));
    say(call, "oi");
    assertEquals(await heard(call, 1), ["Você disse oi."]);
  });
});
