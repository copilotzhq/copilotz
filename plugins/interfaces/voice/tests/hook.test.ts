/**
 * Twilio's side of a call coming in: its signature (Twilio's own example,
 * and anything changed refused), the webhook's answer (the socket, with a
 * ticket, the line's language and greeting), the ticket (once, within a
 * minute, for that call), the line's limits (calls at once, a day: busy,
 * nothing spent), and the end of a call's relay. The settings are checked
 * at start.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createHmac } from "node:crypto";
import { createRuntime, definePlugin } from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import models from "../../../models/mod.ts";
import { chat } from "../../../agents/chat/mod.ts";
import { access } from "../../../access/mod.ts";
import { test } from "../../../../testing/mod.ts";
import { voice } from "../mod.ts";
import { sign, signed } from "../shared/signature.ts";
import type { VoiceCall } from "../collections/call.ts";
import {
  ACCOUNT,
  callSid,
  CARLA,
  fakeRelay,
  LINE_NUMBER,
  ORIGIN,
  setup,
  TOKEN,
  until,
  VERIFIED,
} from "./setup.ts";
import { serveRelay } from "../resources/relay.ts";

test("Twilio's signature: its own example, and nothing else", async () => {
  // Twilio's example request (its helper libraries' tests): the URL, then the sorted fields.
  const url = "https://example.com/myapp.php?foo=1&bar=2";
  const form = new URLSearchParams({
    To: "+18005551212",
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
  });
  assertEquals(await sign("12345", url, form), "L/OH5YylLD5NRKLltdqwSvS0BnU=");
  assert(await signed("12345", "L/OH5YylLD5NRKLltdqwSvS0BnU=", url, form));
  // Made apart, with Node's crypto: the same.
  const text = url + [...form].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => k + v).join("");
  assertEquals(
    createHmac("sha1", "12345").update(text).digest("base64"),
    "L/OH5YylLD5NRKLltdqwSvS0BnU=",
  );
  const changed = new URLSearchParams(form);
  changed.set("Digits", "1235");
  for (
    const [token, at, fields] of [
      ["wrong", url, form],
      ["12345", "https://evil.example/myapp.php?foo=1&bar=2", form],
      ["12345", url, changed],
    ] as const
  ) assertEquals(await signed(token, "L/OH5YylLD5NRKLltdqwSvS0BnU=", at, fields), false);
  for (const header of [undefined, "", "not base64!", "M/OH5YylLD5NRKLltdqwSvS0BnU="]) {
    assertEquals(await signed("12345", header, url, form), false);
  }
});

test("a call comes in: the line's socket, with a ticket, its language and its greeting", async () => {
  await setup(async (s) => {
    const answered = await s.ring();
    assertEquals(answered.status, 200);
    assertEquals(answered.headers.get("content-type"), "text/xml; charset=utf-8");
    const twiml = await answered.text();
    const url = new URL(/url="([^"]+)"/.exec(twiml)![1].replaceAll("&amp;", "&"));
    assertEquals(`${url.origin}${url.pathname}`, "wss://calls.example.com/hooks/voice/help/relay");
    assertEquals(url.searchParams.get("ticket")!.split(".")[0], callSid(1));
    assert(twiml.includes(`<Connect action="${ORIGIN}/hooks/voice/help/over">`));
    assert(twiml.includes('language="pt-BR"'));
    assert(twiml.includes('welcomeGreeting="Olá! Como posso ajudar?"'));
    // No keys asked for, no voice chosen: Twilio's own.
    assert(!twiml.includes("dtmfDetection") && !twiml.includes("voice="));
    const [call] = await s.docs<VoiceCall>("voice_call");
    assertEquals([call._id, call.state, call.line, call.in, call.to], [
      callSid(1),
      "ringing",
      "help",
      "line",
      LINE_NUMBER,
    ]);
    // The ticket is kept as its hash, never as it is.
    assert(call.ticket && !twiml.includes(call.ticket));
  });
});

test("what Twilio didn't sign, or isn't the line's, changes nothing", async () => {
  await setup(async (s) => {
    assertEquals((await s.ring({ token: "someone-elses-token" })).status, 401);
    assertEquals((await s.ring({ form: { AccountSid: `AC${"2".repeat(32)}` } })).status, 403);
    assertEquals((await s.ring({ form: { Direction: "outbound-api" } })).status, 403);
    assertEquals((await s.ring({ path: "/hooks/voice/nobody" })).status, 404);
    assertEquals(await s.docs("voice_call"), []);
  });
});

test("a ticket opens one socket, once, for its call, within a minute", async () => {
  await setup(async (s) => {
    const twiml = await (await s.ring()).text();
    // Signed by someone else: refused, and the ticket still good.
    assertEquals((await s.open(twiml, { token: "not-twilios" })).response.status, 401);
    const first = await s.open(twiml);
    assertEquals(first.response.status, 200);
    assertEquals((await s.open(twiml)).response.status, 401);
    const [call] = await s.docs<VoiceCall>("voice_call");
    assertEquals(call.ticket, undefined);

    // A ticket's secret made up, or another call's: refused.
    const other = await (await s.ring()).text();
    const forged = other.replace(/ticket=CA[0-9a-f]+\.[\w-]+/, `ticket=${callSid(2)}.made-up`);
    assertEquals((await s.open(forged)).response.status, 401);
    const crossed = other.replace(/ticket=CA[0-9a-f]+/, `ticket=${callSid(1)}`);
    assertEquals((await s.open(crossed)).response.status, 401);

    // A minute later, it's too old.
    await s.runtime.call("test.age", { call: callSid(2), ms: 61_000 });
    assertEquals((await s.open(other)).response.status, 401);
  });
});

test("the socket must be the call the ticket was for, and say so in time", async () => {
  await setup(async (s) => {
    const { relay } = await s.open(await (await s.ring()).text());
    relay.tell({
      type: "setup",
      accountSid: ACCOUNT,
      callSid: callSid(1),
      from: "+5511900000000",
      to: LINE_NUMBER,
      direction: "inbound",
    });
    await until(() => relay.closed, 1_000, "the socket to close");
    await until(async () => (await s.docs<VoiceCall>("voice_call"))[0].state === "over");
    assertEquals((await s.docs<VoiceCall>("voice_call"))[0].reason, "setup");
    assertEquals(await s.docs("contact"), []);
  });
});

test("the line's limits: two calls at once, then so many a day; busy, nothing spent", async () => {
  await setup(async (s) => {
    const busy = '<Response><Reject reason="busy"/></Response>';
    const ring = async () => (await (await s.ring()).text()).replace(/^<\?xml[^>]*>/, "");
    assert((await ring()).includes("ConversationRelay"));
    assert((await ring()).includes("ConversationRelay"));
    assertEquals(await ring(), busy);
    assertEquals((await s.docs("voice_call")).length, 2);
    // A ticket nobody used holds its place a minute; then the place is free.
    await s.runtime.call("test.age", { call: callSid(1), ms: 61_000 });
    assert((await ring()).includes("ConversationRelay"));
    // Twilio asking again for a call that's ringing: a new ticket, and no place more.
    const again = await (await s.ring({ call: callSid(4) })).text();
    assert(again.includes("ConversationRelay"));
    assertEquals((await s.docs("voice_call")).length, 3);
  });

  // A day's calls are those that went on: one that rang and never did costs nothing.
  await setup(async (s) => {
    const ring = async (o = {}) => (await (await s.ring(o)).text()).includes("ConversationRelay");
    assertEquals(await ring(), true);
    (await s.call()).hangUp();
    (await s.call()).hangUp();
    await until(async () =>
      (await s.docs<VoiceCall>("voice_call")).filter((c) => c.state === "over").length === 2
    );
    assertEquals(await ring(), false);
    // A call 24 hours ago doesn't count any more.
    const [, first] = await s.docs<VoiceCall>("voice_call");
    await s.runtime.call("test.age", { call: first._id, ms: 86_400_000 + 1_000 });
    assertEquals(await ring(), true);
  }, { line: { limits: { atOnce: 10, perDay: 2 } } });
});

test("a caller's own limits come first: one call at once, so many a day; hidden numbers are one", async () => {
  await setup(async (s) => {
    const ring = async (from: string) =>
      (await (await s.ring({ from })).text()).includes("ConversationRelay");
    assertEquals([await ring(CARLA), await ring(CARLA), await ring("+5531988887777")], [
      true,
      false,
      true,
    ]);
    // Withheld numbers can't be told apart: they're one caller, with or without the "+".
    assertEquals([await ring("+266696687"), await ring("266696687"), await ring("anonymous")], [
      true,
      false,
      false,
    ]);
  }, { line: { limits: { atOnce: 10 } } });

  await setup(async (s) => {
    (await s.call({ from: CARLA })).hangUp();
    await until(async () => (await s.docs<VoiceCall>("voice_call"))[0].state === "over");
    (await s.call({ from: CARLA })).hangUp();
    await until(async () =>
      (await s.docs<VoiceCall>("voice_call")).every((c) => c.state === "over")
    );
    const ring = async (from: string) =>
      (await (await s.ring({ from })).text()).includes("ConversationRelay");
    assertEquals([await ring(CARLA), await ring("+5531988887777")], [false, true]);
  }, { line: { limits: { callerPerDay: 2 } } });
});

test("a blocked caller is rejected as busy; only the line's managers block, and lift it", async () => {
  await setup(async (s) => {
    const call = await s.call({ from: CARLA });
    call.hangUp();
    const [c] = await s.docs<VoiceCall>("voice_call");
    const block = (blocked: boolean, person: string) =>
      s.runtime.call("voice.block", { thread: c.thread, blocked }, {
        actor: { kind: "person", id: person },
      });
    await s.runtime.call("test.member", { person: "eve", role: "editor" });
    await assertRejects(() => block(true, "eve"), Error, "manage");
    await s.runtime.call("test.member", { person: "ana", role: "manager" });
    await block(true, "ana");
    const busy = '<Response><Reject reason="busy"/></Response>';
    const rang = async () =>
      (await (await s.ring({ from: CARLA })).text()).replace(/^<\?xml[^>]*>/, "");
    assertEquals(await rang(), busy);
    // Kept by the number's hash: erasing the contact doesn't let them in again.
    await s.runtime.call("test.erase", { contact: c.contact });
    await s.runtime.idle();
    assertEquals(await rang(), busy);
    const [blockedRow] = await s.docs<{ _id: string }>("voice_blocked");
    assert(!blockedRow._id.includes(CARLA.slice(1)));
    // Lifted (from a newer call of theirs: the erased one doesn't know the number any more).
    await assertRejects(() => block(false, "ana"), Error, "isn't known");
  });
});

test("Twilio's verification of the number is noted on the call", async () => {
  await setup(async (s) => {
    await s.ring({ form: VERIFIED });
    await s.ring({ form: { StirVerstat: "TN-Validation-Passed-C" } });
    assertEquals((await s.docs<VoiceCall>("voice_call")).map((c) => c.verified), [true, undefined]);
  });
});

test("a path that doesn't decode names no line", async () => {
  await setup(async (s) => {
    assertEquals((await s.ring({ path: "/hooks/voice/%E0%A4%A" })).status, 404);
    const relay = await serveRelay(
      new Request("http://localhost/hooks/voice/%E0%A4%A/relay", {
        headers: { upgrade: "websocket" },
      }),
      {
        runtime: s.runtime,
        upgrade: () => ({ socket: fakeRelay().socket, response: new Response() }),
      },
    );
    assertEquals(relay.status, 404);
  });
});

test("a call's relay is over: Twilio says why, and is told to hang up", async () => {
  await setup(async (s) => {
    const call = await s.call();
    const form = {
      CallSid: call.id,
      SessionId: `VX${"a".repeat(32)}`,
      SessionStatus: "completed",
      SessionDuration: "42",
      HandoffData: JSON.stringify({ reason: "agent" }),
    };
    const answered = await s.ring({ path: "/hooks/voice/help/over", call: call.id, form });
    assertEquals(
      await answered.text(),
      '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>',
    );
    const [done] = await s.docs<VoiceCall>("voice_call");
    assertEquals([done.state, done.reason, done.twilio], ["over", "agent", {
      status: "completed",
    }]);
    assert(typeof done.seconds === "number");
  });
});

test("a line's settings are checked at start", async () => {
  const start = (line: Record<string, unknown>) =>
    createRuntime({
      store: memoryStore(),
      plugins: [
        models,
        chat,
        ...access,
        voice,
        definePlugin({
          name: "app",
          resources: {
            voice: {
              lines: {
                help: { in: "line", account: ACCOUNT, token: TOKEN, origin: ORIGIN, ...line },
              },
            },
          },
        }),
      ],
    });
  for (
    const [line, said] of [
      [{ token: "" }, "needs its token"],
      [{ account: "AC123" }, "account SID"],
      [{ origin: "https://calls.example.com/app" }, "no path"],
      [{ language: "Portuguese" }, "BCP-47"],
      [{ limits: { perDay: 0 } }, "limits.perDay"],
      [{ limits: { minutes: 3 } }, "isn't a limit"],
    ] as const
  ) {
    await assertRejects(() => start(line), Error, said);
  }
  await (await start({})).close();
});

// The caller's number never shows in what Twilio is told.
test("the TwiML says nothing of the caller", async () => {
  await setup(async (s) => {
    assert(!(await (await s.ring({ from: CARLA })).text()).includes(CARLA.slice(1)));
  });
});
