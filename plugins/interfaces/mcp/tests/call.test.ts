/**
 * A tool call and the conversation it belongs to: a contact in a chat of
 * its own, named by ChatGPT's session or a handle the app gave; the tool
 * run as that contact, written as a step, answered as the app's agents
 * read it; errors that say only what's public; a request sent again
 * answered once (tools that change things), or fresh (read-only ones);
 * erasure that sticks; an owner that stops mid-call, wherever it stops;
 * and no way into another conversation.
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { definePlugin } from "../../../../runtime/mod.ts";
import { test } from "../../../../testing/mod.ts";
import type { Message, Step } from "../../../agents/chat/mod.ts";
import { callIdOf, conversationOf, sameCallOf } from "../shared/keys.ts";
import { RERUN_MS } from "../collections/receipt.ts";
import {
  AGAIN,
  begun,
  charges,
  closed,
  handleIn,
  hangs,
  own,
  runs,
  said,
  SECRET,
  type Setup,
  setup,
  state,
  stopping,
  until,
  within,
  type Write,
} from "./setup.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";

const SCOPE = { line: "chatgpt" };
const chatOf = (session: string, subject?: string) =>
  conversationOf(SECRET, SCOPE, { session, ...(subject ? { subject } : {}) });
const FAILED = "Something went wrong running that tool. Try again in a moment.";

test("a call: a contact in a chat of its own, the tool run as it, a step, the agents' reading", async () => {
  await setup(async (s) => {
    const answer = await s.call("search", { to: "Rio" }, { session: "conv-1", subject: "user-1" });
    assertEquals(answer.status, 200);
    // What the app's own agents read (its View), never what the View leaves out.
    assertEquals(said(answer), "2 trips: Rio 10:30, Rio 14:00");
    assertEquals(answer.body.result?.isError, undefined);
    const { contact, thread } = await chatOf("conv-1", "user-1");
    const [found] = await s.docs<{ _id: string; in: string; via: string }>("contact");
    assertEquals([found._id, found.in, found.via], [contact, "line", "mcp"]);
    const [chat] = (await s.docs<{ _id: string; in: string; title: string }>("thread"))
      .filter((t) => t._id === thread);
    assertEquals([chat.in, chat.title], ["line", "ChatGPT"]);
    // The step, as an agent's: private, from the client, the call with what it returned.
    const [step] = await s.steps(thread);
    assertEquals([step.from, step.private, step.in, step.to], ["ChatGPT", true, "line", []]);
    const [made] = step.toolCalls as Step[];
    assertEquals([made.name, made.input], ["search", { to: "Rio" }]);
    assertEquals(JSON.parse(made.output).secret, "kept out by its View");
    // Its id: hashes of the request's id and of what it asks, nothing the client sent as it came.
    assertMatch(made.id, new RegExp(`^mcp:${thread}:[0-9a-f]{16}:[0-9a-f]{16}$`));
    assertEquals((chat as unknown as { messages: number }).messages, 0);
  });
});

test("the tool runs as the contact: its client, its chat; its callId and trigger the step", async () => {
  await setup(async (s) => {
    const who = JSON.parse(said(await s.call("whoami", {}, { session: "conv-1" })));
    const { contact, thread } = await chatOf("conv-1");
    assertEquals([who.kind, who.id], ["contact", contact]);
    assertEquals([who.mcp, who.client, who.agent, who.thread], [
      "chatgpt",
      "ChatGPT",
      "ChatGPT",
      thread,
    ]);
    const [step] = await s.steps(thread);
    const [call] = step.toolCalls as Step[];
    assertEquals([who.trigger, who.callId, who.retry], [step._id, step._id, false]);
    assert(step._id.startsWith(`${call.id}@`));
  });
});

test("a request's id is hashed into the call's: what a client sends never reaches a tool as it came", async () => {
  await setup(async (s) => {
    const evil = "../../v1/orders/123?refund=1\r\nX-Evil: 1";
    const who = JSON.parse(said(await s.call("whoami", {}, { session: "c", id: evil })));
    assertMatch(who.callId, /^mcp:mcp-[0-9a-f]{32}:[0-9a-f]{16}:[0-9a-f]{16}@[0-9a-z]+$/);
    assert(!who.trigger.includes("..") && !who.trigger.includes("\r"));
  });
});

test("one ChatGPT conversation is one chat; another session, or another user, is another", async () => {
  await setup(async (s) => {
    await s.call("pick", { trip: "T1" }, { session: "conv-1", subject: "ana" });
    await s.call("search", { to: "Rio" }, { session: "conv-1", subject: "ana" });
    await s.call("search", { to: "Rio" }, { session: "conv-2", subject: "ana" });
    await s.call("search", { to: "Rio" }, { session: "conv-1", subject: "bob" });
    const one = await chatOf("conv-1", "ana");
    assertEquals((await s.steps(one.thread)).length, 2);
    assertEquals((await s.docs("thread")).length, 3);
    assertEquals((await s.docs("contact")).length, 3);
    assertEquals(
      said(await s.call("peek", {}, { session: "conv-1", subject: "ana" })),
      "Booked: T1",
    );
    assertEquals(
      said(await s.call("peek", {}, { session: "conv-2", subject: "ana" })),
      "No booking.",
    );
  });
});

test("no conversation reaches another's: not by naming its chat, nor by its booking", async () => {
  await setup(async (s) => {
    await s.call("pick", { trip: "T1" }, { session: "conv-1" });
    const theirs = await chatOf("conv-1");
    const peek = await s.call("peek", { thread: theirs.thread }, { session: "conv-2" });
    assertEquals(said(peek), "No booking.");
    const stranger = await s.call("peek", { thread: theirs.thread });
    assertEquals(said(stranger).split("\n")[0], "No booking.");
    // The contact is let into its chat only, never the space.
    const members = await s.docs<{ member: string; space: string; on?: string }>("member");
    const own = members.filter((m) => m.member === `contact:${theirs.contact}`);
    assertEquals(own.map((m) => m.on).sort(), ["contact", "thread"]);
  });
});

test("a client without a session gets a handle, said once; with it, its calls go on in one chat", async () => {
  await setup(async (s) => {
    const first = await s.call("pick", { trip: "T9" });
    const handle = handleIn(first);
    assert(handle, said(first));
    assertEquals(said(first), `Picked T9.\n\nchat: ${handle}`);
    // Said once: the answers after it don't repeat it.
    const second = await s.call("peek", { chat: handle });
    assertEquals(said(second), "Booked: T9");
    const { thread } = await conversationOf(SECRET, SCOPE, { handle });
    assertEquals((await s.steps(thread)).length, 2);
    assertEquals((await s.docs("thread")).length, 1);
    // A handle is never kept: only its chat, by its HMAC.
    const stored = JSON.stringify([
      await s.docs("message"),
      await s.docs("contact"),
      await s.docs("thread"),
      await s.docs("mcp_receipt"),
    ]);
    assert(!stored.includes(handle));
    const other = handleIn(await s.call("peek", {}));
    assertNotEquals(other, handle);
    assertEquals((await s.docs("thread")).length, 2);
  });
});

test("a handle the app never gave is refused, and makes nothing", async () => {
  await setup(async (s) => {
    for (const chat of ["made-up", "A".repeat(22), 42]) {
      const refused = await s.call("peek", { chat });
      assertEquals(refused.body.result?.isError, true);
      assertMatch(said(refused), /isn't one this app gave/);
    }
    assertEquals(runs.peek, undefined);
    assertEquals((await s.docs("thread")).length, 0);
    assertEquals((await s.docs("contact")).length, 0);
  });
});

test("with a session, a handle sent along is ignored; with handles off, a call without one is refused", async () => {
  await setup(async (s) => {
    const answer = await s.call("search", { to: "Rio", chat: "A".repeat(22) }, { session: "c" });
    assertEquals(said(answer), "2 trips: Rio 10:30, Rio 14:00");
  });
  await setup(async (s) => {
    for (let i = 0; i < 3; i++) {
      const refused = await s.call("pick", { trip: "T1" });
      assertEquals(refused.body.result?.isError, true);
      assertMatch(said(refused), /ChatGPT conversations/);
    }
    assertEquals(runs.pick, undefined);
    assertEquals([(await s.docs("thread")).length, (await s.docs("contact")).length], [0, 0]);
    assertEquals(said(await s.call("pick", { trip: "T1" }, { session: "s" })), "Picked T1.");
  }, { line: { handles: false } });
});

test("errors: only a public one says its message; any other, coded or not, that it failed", async () => {
  await setup(async (s) => {
    const boom = await s.call("boom", {}, { session: "c" });
    assertEquals([boom.status, boom.body.result?.isError, said(boom)], [200, true, FAILED]);
    assert(!boom.text.includes("hunter2") && !boom.text.includes("10.0.0.5"));
    const { thread } = await chatOf("c");
    const [step] = await s.steps(thread);
    assertMatch((step.toolCalls as Step[])[0].output, /^Error: connect ECONNREFUSED/);
    assertEquals(said(await s.call("refuse", {}, { session: "c" })), "That date is in the past.");
    assertEquals(
      said(await s.call("later", {}, { session: "c" })),
      "Search trips first: possible now: search_trips.",
    );
    // A code isn't permission: a library's (ECONNREFUSED), or the app's own unmarked failure.
    for (const tool of ["driver", "coded"]) {
      const failed = await s.call(tool, {}, { session: "c" });
      assertEquals(said(failed), FAILED, tool);
      assert(!failed.text.includes("hunter2") && !failed.text.includes("secret"));
    }
    // Input that doesn't fit the tool's schema: said, so the model can mend it.
    const wrong = await s.call("search", { to: 5 }, { session: "c" });
    assertEquals(wrong.body.result?.isError, true);
    assertMatch(said(wrong), /search input/);
    assertEquals(runs.search, undefined);
  });
});

test("input that doesn't fit the tool's schema is kept as text, never as the tool's input", async () => {
  await setup(async (s) => {
    // Input the schema refuses (`to` an object, a field it doesn't take): kept only as text.
    const odd = { to: { as: "an object" }, extra: { deep: [1, 2, 3] } };
    await s.call("search", odd, { session: "c" });
    const { thread } = await chatOf("c");
    const [step] = await s.steps(thread);
    const { input } = (step.toolCalls as Step[])[0];
    assertEquals(Object.keys(input ?? {}), ["unchecked"]);
    assertEquals((input as { unchecked: unknown }).unchecked, JSON.stringify(odd));
  });
});

test("arguments holding a blob reference are refused: only the app writes those", async () => {
  await setup(async (s) => {
    const ref = { $blob: "../../../../etc/hosts", size: 1, type: "text/plain" };
    for (const input of [{ x: ref }, { x: [{ y: ref }] }]) {
      const refused = await s.call("whoami", input, { session: "c" });
      assertEquals(refused.body.error?.code, -32602);
    }
    assertEquals(runs.whoami, undefined);
    // Nested past what any tool takes: refused before anything reads it (recursively).
    const deep = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami",` +
      `"arguments":{"x":${"[".repeat(20_000)}${"]".repeat(20_000)}},` +
      `"_meta":{"openai/session":"deep"}}}`;
    const refused = await s.post(deep, { headers: { "mcp-protocol-version": "2025-11-25" } });
    assertEquals([refused.status, refused.body.error?.code], [200, -32602]);
    assertEquals(runs.whoami, undefined);
  });
});

test("a tool that changes things: sent again, answered from the first; asked again later, run", async () => {
  await setup(async (s) => {
    const first = await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    const again = await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    // Said again, saying so: a model asking twice on purpose isn't told it was done twice.
    assertMatch(said(again), AGAIN);
    assertEquals(own(said(again)), said(first));
    assertEquals(runs.pick, 1);
    const { thread } = await chatOf("c");
    assertEquals((await s.steps(thread)).length, 1);
    // A client that numbers each call from 1: the same id, asking something else, runs.
    assertEquals(said(await s.call("pick", { trip: "T2" }, { session: "c", id: 7 })), "Picked T2.");
    assertEquals(runs.pick, 2);
    // A failure by accident ("try again") isn't kept: asked again, it runs again, as itself.
    await s.call("boom", {}, { session: "c", id: 8 });
    const boomAgain = await s.call("boom", {}, { session: "c", id: 8 });
    assertEquals([boomAgain.body.result?.isError, runs.boom], [true, 2]);
    // Two minutes after its answer, the same request is asked again for a reason: it runs, as a
    // new call, with a callId of its own (what it does outside isn't taken for the first's).
    const before = JSON.parse(said(await s.call("whoami", {}, { session: "c", id: 9 })));
    await s.runtime.call("test.age", { ms: 121_000 });
    await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    assertEquals(runs.pick, 3);
    const after = JSON.parse(said(await s.call("whoami", {}, { session: "c", id: 9 })));
    assertNotEquals(after.callId, before.callId);
    const names = (await s.steps(thread)).map((m) => (m.toolCalls as Step[])[0].name);
    assertEquals(names, ["pick", "pick", "boom", "whoami", "pick", "whoami"]);
  });
});

test("a deliberate second, identical call is told it wasn't done again, never that it was", async () => {
  await setup(async (s) => {
    assertEquals(said(await s.call("pick", { trip: "T1" }, { session: "d", id: 1 })), "Picked T1.");
    const second = said(await s.call("pick", { trip: "T1" }, { session: "d", id: 2 }));
    assertMatch(second, /^This same request was made moments ago, and it wasn't done again/);
    assertEquals(own(second), "Picked T1.");
    assertEquals(runs.pick, 1);
    // Another conversation's identical call is its own.
    assertEquals(said(await s.call("pick", { trip: "T1" }, { session: "e", id: 1 })), "Picked T1.");
    assertEquals(runs.pick, 2);
  });
});

test("a failure by accident: the retry it asks for runs again, as itself; a refusal is said again", async () => {
  await setup(async (s) => {
    // `boom` fails as a bare throw: "try again in a moment". The model does, under a new id.
    const first = await s.call("boom", {}, { session: "f", id: 1 });
    assertMatch(said(first), /Try again in a moment/);
    const retry = await s.call("boom", {}, { session: "f", id: 2 });
    assertEquals(runs.boom, 2);
    assert(!AGAIN.test(said(retry)));
    // The same step, the same callId: the tool knows it's the retry.
    const { thread } = await chatOf("f");
    assertEquals(
      (await s.steps(thread)).filter((m) => (m.toolCalls as Step[])[0].name === "boom").length,
      1,
    );
    // A public refusal is a deliberate answer: asked again, it's said again, not run.
    const refused = said(await s.call("refuse", {}, { session: "f", id: 3 }));
    const again = said(await s.call("refuse", {}, { session: "f", id: 4 }));
    assertEquals([refused, own(again), runs.refuse], ["That date is in the past.", refused, 1]);
    assertMatch(again, AGAIN);
  });
});

test("a read-only tool keeps no receipt: the same request always runs, and says what's true now", async () => {
  await setup(async (s) => {
    const first = await s.call("status", {}, { session: "c", id: 1 });
    state.paid = true;
    const second = await s.call("status", {}, { session: "c", id: 1 });
    assertEquals([said(first), said(second)], ["Not paid yet.", "Paid."]);
    assertEquals(runs.status, 2);
    assertEquals((await s.docs("mcp_receipt")).length, 0);
    const { thread } = await chatOf("c");
    assertEquals((await s.steps(thread)).length, 2);
  });
});

test("a call cut short runs again as itself: the same step, the same callId, with retry", async () => {
  await setup(async (s) => {
    const { thread } = await chatOf("c");
    const call = await callIdOf(thread, 5, "whoami", {});
    // It began (its receipt, written before the tool ran), then its executor was lost.
    await s.call("search", { to: "Rio" }, { session: "c" });
    // Its receipt is by what it asks in the conversation, whatever the request's id.
    await s.runtime.call("test.cut", {
      call: await sameCallOf(thread, "whoami", {}),
      step: `${call}@cut`,
    });
    const who = JSON.parse(said(await s.call("whoami", {}, { session: "c", id: 5 })));
    assertEquals([who.callId, who.trigger, who.retry], [`${call}@cut`, `${call}@cut`, true]);
    const steps = await s.steps(thread);
    assertEquals(steps.at(-1)!._id, `${call}@cut`);
  });
});

test("the same request twice at once runs once; two different first calls share one chat", async () => {
  await setup(async (s) => {
    const [a, b] = await Promise.all([
      s.call("slow", {}, { session: "c", id: "same" }),
      s.call("slow", {}, { session: "c", id: "same" }),
    ]);
    assertEquals([own(said(a)), own(said(b))], ["Done, slowly.", "Done, slowly."]);
    // The one that joined says it wasn't done again.
    assertEquals([said(a), said(b)].filter((t) => AGAIN.test(t)).length, 1);
    assertEquals(runs.slow, 1);
    const [c, d] = await Promise.all([
      s.call("search", { to: "A" }, { session: "new" }),
      s.call("search", { to: "B" }, { session: "new" }),
    ]);
    assertEquals([said(c), said(d)], ["2 trips: A 10:30, A 14:00", "2 trips: B 10:30, B 14:00"]);
    const { thread } = await chatOf("new");
    assertEquals((await s.steps(thread)).length, 2);
  });
});

test("at once: past the line's calls at once, the server is busy, and nothing runs", async () => {
  await setup(async (s) => {
    const all = await Promise.all(
      Array.from({ length: 5 }, (_, i) => s.call("slow", {}, { session: `s${i}` })),
    );
    const busy = all.filter((r) => r.status === 503);
    assertEquals([all.length - busy.length, busy.length], [2, 3]);
    assertEquals(busy[0].body.error?.code, -31000);
    assertEquals(busy[0].headers.get("retry-after"), "1");
    assertEquals(runs.slow, 2);
    // Once they're done, it takes calls again.
    assertEquals(said(await s.call("slow", {}, { session: "after" })), "Done, slowly.");
  }, { line: { limits: { atOnce: 2 } } });
});

test("at once: many calls at once never lose the executor; past the cap, busy, then served", async () => {
  await setup(async (s) => {
    const all = await Promise.all(
      Array.from({ length: 30 }, (_, i) => s.call("search", { to: "X" }, { session: `p${i}` })),
    );
    // Taken or busy: never an internal error.
    assert(all.every((r) => r.status === 200 || r.status === 503), JSON.stringify(all[0].body));
    assert(all.every((r) => !r.body.error || r.body.error.code === -31000));
    assert(all.some((r) => r.status === 200));
    assertEquals(
      said(await s.call("search", { to: "Rio" }, { session: "after" })).slice(0, 7),
      "2 trips",
    );
  });
});

test("limits: only calls taken count; past one, refused and nothing written", async () => {
  await setup(async (s) => {
    for (let i = 0; i < 2; i++) await s.call("search", { to: `R${i}` }, { session: "c" });
    const third = await s.call("search", { to: "R3" }, { session: "c" });
    assertMatch(said(third), /Too many calls in this conversation/);
    const { thread } = await chatOf("c");
    assertEquals([(await s.steps(thread)).length, runs.search], [2, 2]);
    // Refused calls didn't count: the minute after, the conversation is as it was.
    await s.runtime.call("test.age", { minute: true });
    assertEquals(
      said(await s.call("search", { to: "R4" }, { session: "c" })).slice(0, 7),
      "2 trips",
    );
  }, { line: { limits: { perMinute: 2 } } });
});

test("limits: a burst refused by the line doesn't spend the hour's new conversations", async () => {
  await setup(async (s) => {
    // From many addresses (no address limit): the line's minute takes 2.
    for (let i = 0; i < 5; i++) {
      await s.call("search", { to: "X" }, {
        session: `junk-${i}`,
        headers: { "cf-connecting-ip": `198.51.100.${i}` },
      });
    }
    assertEquals((await s.docs("thread")).length, 2);
    await s.runtime.call("test.age", { minute: true });
    // Two new conversations counted, not five: a real user's first call is taken.
    const real = await s.call("search", { to: "Rio" }, { session: "real-user" });
    assertEquals(said(real).slice(0, 7), "2 trips");
  }, { line: { limits: { linePerMinute: 2, chatsPerHour: 3 } } });
});

test("limits: new conversations an hour, on the line and by user, counted once made", async () => {
  await setup(async (s) => {
    await s.call("search", { to: "A" }, { session: "s1", subject: "ana" });
    const second = await s.call("search", { to: "A" }, { session: "s2", subject: "ana" });
    assertMatch(said(second), /Too many new conversations/);
    assertEquals(
      said(await s.call("search", { to: "B" }, { session: "s1", subject: "ana" })).slice(0, 7),
      "2 trips",
    );
    assertEquals(
      said(await s.call("search", { to: "C" }, { session: "s3", subject: "bob" })).slice(0, 7),
      "2 trips",
    );
    assertEquals((await s.docs("contact")).length, 2);
  }, { line: { limits: { userChatsPerHour: 1 } } });
  await setup(async (s) => {
    await s.call("search", { to: "A" }, { session: "s1" });
    assertMatch(said(await s.call("search", { to: "A" }, { session: "s2" })), /busy/);
    assertEquals(handleIn(await s.call("search", { to: "A" })), undefined);
    assertEquals((await s.docs("thread")).length, 1);
  }, { line: { limits: { chatsPerHour: 1 } } });
});

test("limits by address: as the app's front says it, only through it; exempt ranges aren't", async () => {
  await setup(async (s) => {
    const from = (ip: string, front = "the-front-secret-for-tests") => ({
      headers: { "cf-connecting-ip": ip, "x-copilotz-front": front },
    });
    // One address: 2 calls a minute, whatever conversations it names.
    await s.call("search", { to: "A" }, { session: "a1", ...from("203.0.113.9") });
    await s.call("search", { to: "A" }, { session: "a2", ...from("203.0.113.9") });
    const third = await s.call("search", { to: "A" }, { session: "a3", ...from("203.0.113.9") });
    assertMatch(said(third), /Too many calls from here/);
    // Another address goes on.
    assertEquals(
      said(await s.call("search", { to: "A" }, { session: "b1", ...from("203.0.113.10") })).slice(
        0,
        7,
      ),
      "2 trips",
    );
    // Without the front's secret, it came around the front, straight to the app: refused.
    for (const front of ["wrong", ""]) {
      const around = await s.call("search", { to: "A" }, {
        session: "around",
        ...from("203.0.113.11", front),
      });
      assertEquals([around.status, around.body.error?.message], [
        403,
        "Not through the app's front",
      ]);
    }
    assertEquals((await s.docs<{ _id: string }>("contact")).length, 3);
    // A shared proxy's range (OpenAI's, for ChatGPT's users): not limited by address.
    for (let i = 0; i < 4; i++) {
      const proxied = await s.call("search", { to: "A" }, {
        session: `o${i}`,
        ...from("192.0.2.44"),
      });
      assertEquals(said(proxied).slice(0, 7), "2 trips");
    }
  }, {
    line: { limits: { ipPerMinute: 2 } },
    settings: {
      caller: {
        header: "cf-connecting-ip",
        front: "the-front-secret-for-tests",
        exempt: ["192.0.2.0/24"],
      },
    },
  });
});

test("limits by address: behind proxies (hops), the entry they appended; any other caller's claim isn't", async () => {
  await setup(async (s) => {
    const via = (list: string) => ({
      headers: { "x-forwarded-for": list, "cf-connecting-ip": "" },
    });
    // The caller writes the first entries; the last is the proxy's: 2 calls a minute from there.
    for (let i = 0; i < 2; i++) {
      await s.call("search", { to: "A" }, { session: `x${i}`, ...via(`10.9.9.${i}, 203.0.113.7`) });
    }
    const third = await s.call("search", { to: "A" }, {
      session: "x2",
      ...via("10.9.9.2, 203.0.113.7"),
    });
    assertMatch(said(third), /Too many calls from here/);
    // Claiming a range that's exempt, in an entry the caller wrote, exempts nothing.
    const claimed = await s.call("search", { to: "A" }, {
      session: "x3",
      ...via("192.0.2.1, 203.0.113.7"),
    });
    assertMatch(said(claimed), /Too many calls from here/);
    // An address that can't be read (none, garbled): counted together, never unlimited.
    for (const list of ["", "not-an-address", "1.2.3.999"]) {
      await s.call("search", { to: "A" }, { session: `u-${list}`, ...via(list) });
    }
    assertEquals((await s.docs("thread")).length, 4);
  }, {
    line: { limits: { ipPerMinute: 2 } },
    settings: { caller: { header: "x-forwarded-for", hops: 1, exempt: ["192.0.2.0/24"] } },
  });
});

test("limits by address: IPv6 by its /64; IPv4 written as IPv6 is the same IPv4 caller", async () => {
  await setup(async (s) => {
    const from = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });
    for (const ip of ["2001:db8:1:2::1", "2001:db8:1:2:ffff::9"]) {
      await s.call("search", { to: "A" }, { session: ip, ...from(ip) });
    }
    assertMatch(
      said(await s.call("search", { to: "A" }, { session: "v6", ...from("2001:db8:1:2::3") })),
      /from here/,
    );
    assertEquals(
      said(await s.call("search", { to: "A" }, { session: "v6b", ...from("2001:db8:1:3::1") }))
        .slice(0, 7),
      "2 trips",
    );
    await s.call("search", { to: "A" }, { session: "m1", ...from("203.0.113.99") });
    await s.call("search", { to: "A" }, { session: "m2", ...from("::ffff:203.0.113.99") });
    assertMatch(
      said(await s.call("search", { to: "A" }, { session: "m3", ...from("::ffff:cb00:7163") })),
      /from here/,
    );
  }, { line: { limits: { ipPerMinute: 2, ipChatsPerHour: 50 } } });
});

test("at once by caller: 2 calls from one address, and 2 in one conversation; a batch counts each", async () => {
  await setup(async (s) => {
    const from = (ip: string) => ({ "cf-connecting-ip": ip });
    // One address: two run, the third is busy; another address is served meanwhile.
    const one = await Promise.all(
      [0, 1, 2].map((i) => s.call("slow", {}, { session: `a${i}`, headers: from("203.0.113.20") })),
    );
    assertEquals(one.map((r) => r.status).sort(), [200, 200, 503]);
    // One conversation, from three addresses, three different calls: the same.
    const chat = await Promise.all(
      [0, 1, 2].map((i) =>
        s.call("hang", { ms: 150 + i }, {
          session: "c",
          id: `c${i}`,
          headers: from(`203.0.113.${30 + i}`),
        })
      ),
    );
    assertEquals(chat.map((r) => r.status).sort(), [200, 200, 503]);
    // A batch of three calls from one address could never run at once: refused, not busy.
    const batch = await s.post(
      [0, 1, 2].map((i) => ({
        jsonrpc: "2.0",
        id: i,
        method: "tools/call",
        params: { name: "search", arguments: { to: "X" }, _meta: { "openai/session": `b${i}` } },
      })),
      { headers: { "mcp-protocol-version": "", ...from("203.0.113.40") } },
    );
    assertEquals([batch.status, batch.headers.get("retry-after")], [400, null]);
    assertEquals(batch.body.error?.code, -32600);
    assertMatch(batch.body.error?.message ?? "", /at most 2 tool calls \(addressAtOnce\)/);
  });
});

test("past the line's timeout, the model is told it's still working; asked again, it answers", async () => {
  await setup(async (s) => {
    const late = await s.call("slow", {}, { session: "c", id: 1 });
    assertEquals(late.body.result?.isError, true);
    assertMatch(said(late), /^Still working on it/);
    // It goes on: asked again (any request id), it waits for the same run, then answers from it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEquals(own(said(await s.call("slow", {}, { session: "c", id: 1 }))), "Done, slowly.");
    assertEquals(runs.slow, 1);
    const { thread } = await chatOf("c");
    const [step] = await s.steps(thread);
    assertEquals((step.toolCalls as Step[])[0].output, "Done, slowly.");
  }, { line: { limits: { timeout: 0.05 } } });
});

test("a tool that ignores its signal, past the timeout: one effect, however often it's asked again", async () => {
  await setup(async (s) => {
    const asks = [];
    // The first, then the model asking again under the same id and under new ones, while it runs.
    for (const id of [1, 1, 2, 3]) {
      asks.push(await s.call("charge", {}, { session: "pay", id }));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    // Each is told it's still working, or, once it's done, what it did.
    assertMatch(said(asks[0]), /^Still working on it/);
    assert(asks.every((a) => /^(Still working on it|Charged once)/.test(own(said(a)))));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const answered = said(await s.call("charge", {}, { session: "pay", id: 1 }));
    assertMatch(answered, AGAIN);
    assertMatch(own(answered), /^Charged once, with key mcp:/);
    assertEquals(charges.length, 1);
  }, { line: { limits: { timeout: 0.03 } } });
});

test("a call still running past stop is stopped; asked again, it runs again as itself (retry)", async () => {
  await setup(async (s) => {
    const ask = () => s.call("hang", { ms: 300 }, { session: "h", id: 1 });
    assertMatch(said(await ask()), /^Still working on it/);
    // Stopped at 0.1 s; asked again after, it runs again as the same call, told it's a retry.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rerun = JSON.parse(said(await ask()));
    assertEquals(rerun.retry, true);
    assertMatch(rerun.callId, /^mcp:mcp-[0-9a-f]{32}:[0-9a-f]{16}:[0-9a-f]{16}@/);
    // The first, ignoring its signal, ended too: with the same callId, the key to do it once.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEquals(hangs, [rerun.callId, rerun.callId]);
  }, { line: { limits: { timeout: 0.03, stop: 0.1 } } });
});

test("after a stop, the model asking again under a new request id runs the same call again", async () => {
  await setup(async (s) => {
    assertMatch(said(await s.call("hang", { ms: 300 }, { session: "h", id: 1 })), /^Still working/);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Stopped at 0.1 s. Asked again with another id: the same step, the same callId, a retry.
    const again = JSON.parse(said(await s.call("hang", { ms: 300 }, { session: "h", id: 2 })));
    assertEquals(again.retry, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEquals(hangs.length, 2);
    assertEquals(new Set(hangs).size, 1);
  }, { line: { limits: { timeout: 0.03, stop: 0.1 } } });
});

test("an owner restarted mid-call: asked again under any id, the same call runs again as itself", async () => {
  const store = memoryStore();
  let first = "";
  await setup(async (a) => {
    assertMatch(said(await a.call("hang", { ms: 300 }, { session: "r", id: 1 })), /^Still working/);
    // The owner stops while its tool runs, however slow the machine is to get there.
    first = await until(() => begun[0], "the first call's tool began");
    closed.add(a.runtime);
    await a.runtime.close({ drain: 0 });
    // Its tool, ignoring its signal, ends too, in the owner that stopped: nothing it writes lands.
    await until(() => hangs.includes(first), "the first call's tool ended");
  }, { store, line: { limits: { timeout: 0.03 } } });
  // A new runtime, nothing in its memory: the receipt, kept with the store, says how it went.
  // It waits as long as it takes (the line's own timeout): what's tested is the restart.
  await setup(async (b) => {
    const again = JSON.parse(said(await b.call("hang", { ms: 300 }, { session: "r", id: 2 })));
    assertEquals([again.callId, again.retry], [first, true]);
    const same = said(await b.call("hang", { ms: 300 }, { session: "r", id: 1 }));
    assertMatch(same, AGAIN);
    // Every effect under one callId: the first run's, and the one that ran again.
    assertEquals(JSON.parse(own(same)).callId, first);
    assertEquals(hangs, [first]);
  }, { store });
});

/** The writes of a conversation's first call an owner may stop at, in order. */
const WRITES: Record<string, (w: Write) => boolean> = {
  "its contact": (w) => w.op === "insert" && w.collection === "contact",
  "its contact's own record, shared with it": (w) =>
    w.collection === "member" && w.doc?.on === "contact",
  "its chat": (w) => w.op === "insert" && w.collection === "thread",
  "its chat, shared with its contact": (w) => w.collection === "member" && w.doc?.on === "thread",
  "its opening, done": (w) => w.op === "delete" && w.collection === "mcp_opening",
  "its step": (w) => w.collection === "message",
};

/**
 * A conversation's first call, its owner stopped at one of its writes (that
 * write never lands, nor anything after it), and a new owner on the same
 * store, asked again: `then` gets it, and the conversation's ids.
 */
async function stoppedAt(
  at: (w: Write) => boolean,
  then: (b: Setup, ids: { contact: string; thread: string; first: string }) => Promise<void>,
) {
  const store = memoryStore();
  const owner = stopping(store, at);
  await setup(async (a) => {
    try {
      const asked = a.call("hang", { ms: 0 }, { session: "r", id: 1 });
      await within(owner.reached, "the first call got there");
      await asked;
    } finally {
      // Stopped and closed whatever happened, so nothing waits on it.
      owner.stop();
      closed.add(a.runtime);
      // Gone, it can't even save its Processors' positions.
      await a.runtime.close({ drain: 0 }).catch(() => {});
    }
  }, { store: owner.store, line: { limits: { timeout: 0.03 } } });
  const { contact, thread } = await chatOf("r");
  // The step the first call began, which it's asked as again: request 1's, whatever the id.
  const first = await callIdOf(thread, 1, "hang", { ms: 0 });
  await setup((b) => then(b, { contact, thread, first }), { store });
}

test("an owner stopped at any write of a conversation's first call: asked again, it goes on", async () => {
  for (const [write, at] of Object.entries(WRITES)) {
    await stoppedAt(at, async (b, { contact, thread, first }) => {
      const again = said(await b.call("hang", { ms: 0 }, { session: "r", id: 2 }));
      assertMatch(again, /^\{/, `stopped at ${write}: ${again}`);
      // The same call, run again as itself.
      const { callId, retry } = JSON.parse(again);
      assertEquals([callId.startsWith(`${first}@`), retry], [true, true], write);
      // Made, as if it had never stopped: one contact, its chat shared with it, opened.
      const shares = (await b.docs<{ _id: string }>("member")).map((m) => m._id);
      assert(shares.includes(`thread:${thread}|contact:${contact}`), write);
      assert(shares.includes(`contact:${contact}|contact:${contact}`), write);
      assertEquals((await b.docs("contact")).length, 1, write);
      assertEquals(await b.docs("mcp_opening"), [], write);
      // From here, taken out of its chat, the contact is out for good.
      await b.runtime.call("test.out", { thread, contact });
      assertMatch(said(await b.call("hang", { ms: 0 }, { session: "r", id: 3 })), /over/, write);
    });
  }
});

test("stopped before its chat was shared: past 15 minutes, or erased, the conversation is over", async () => {
  const share = WRITES["its chat, shared with its contact"];
  // Asked again too late: what began is gone, as a call begun and never done is.
  await stoppedAt(share, async (b) => {
    await b.runtime.call("test.age", { ms: RERUN_MS });
    assertMatch(said(await b.call("hang", { ms: 0 }, { session: "r", id: 2 })), /over/);
    assertEquals(begun, []);
  });
  // Erased in between (contact.forget, its chat kept): over at once, the contact never made again.
  await stoppedAt(share, async (b, { contact, thread }) => {
    await b.runtime.call("test.forget", { contact, thread, chats: false });
    assertMatch(said(await b.call("hang", { ms: 0 }, { session: "r", id: 2 })), /over/);
    assertEquals([begun, await b.docs("contact")], [[], []]);
  });
});

test("past the timeout, few calls go on: 1 started from an address, 2 on the line; the rest stop", async () => {
  await setup(async (s) => {
    const from = (ip: string) => ({ "cf-connecting-ip": ip });
    const ask = (session: string, ip: string) =>
      s.call("hang", { ms: 400 }, { session, headers: from(ip) });
    // One address: its first goes on past the timeout; its second, at the same time, is stopped.
    const [one, two] = await Promise.all([ask("a1", "203.0.113.60"), ask("a2", "203.0.113.60")]);
    assertEquals([said(one), said(two)].map((t) => t.slice(0, 13)).sort(), [
      "It took too l",
      "Still working",
    ]);
    // A second address takes the line's other place past it; a third finds none.
    assertMatch(said(await ask("b1", "203.0.113.61")), /^Still working/);
    assertMatch(said(await ask("c1", "203.0.113.62")), /^It took too long, while too many/);
  }, { line: { limits: { timeout: 0.03, stop: 5 } } });
});

test("at the cap, tools that change things run together without losing the executor", async () => {
  for (let round = 0; round < 5; round++) {
    await setup(async (s) => {
      const all = await Promise.all([0, 1, 2, 3].map((i) =>
        s.call("pick", { trip: `T${round}` }, {
          session: `cap-${round}-${i}`,
          headers: { "cf-connecting-ip": `198.51.100.${Math.floor(i / 2)}` },
        })
      ));
      assertEquals(all.map((r) => [r.status, said(r)]), all.map(() => [200, `Picked T${round}.`]));
    });
  }
});

test("who the user is and where they call from are in no event", async () => {
  await setup(async (s) => {
    const seen: unknown[] = [];
    const stop = s.runtime.subscribe((item) => {
      if (item.kind === "event") seen.push(item.event);
    });
    await s.call("pick", { trip: "T1" }, { session: "conv-A", subject: "ana" });
    await s.call("pick", { trip: "T2" }, { session: "conv-B", subject: "ana" });
    await s.runtime.idle();
    stop();
    assert(seen.length > 10);
    const logged = JSON.stringify(seen);
    assert(!logged.includes('"user"') && !logged.includes('"address"'), "an event names them");
    assert(!/"u-[0-9a-f]{24}"|"a-[0-9a-f]{24}"/.test(logged), "an event holds their HMACs");
  });
});

test("a runtime's calls at once are its own: one org's busy line leaves another's free", async () => {
  await setup(async (a) => {
    await setup(async (b) => {
      const held = a.call("slow", {}, { session: "a1" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEquals(
        (await a.call("slow", {}, {
          session: "a2",
          headers: { "cf-connecting-ip": "203.0.113.2" },
        })).status,
        503,
      );
      assertEquals(
        said(await b.call("search", { to: "Rio" }, { session: "b1" })).slice(0, 7),
        "2 trips",
      );
      await held;
    }, { settings: { atOnce: 1 } });
  }, { settings: { atOnce: 1 } });
});

test("the same request while it runs, from another address, joins it", async () => {
  await setup(async (s) => {
    const [a, b] = await Promise.all([
      s.call("slow", {}, {
        session: "j",
        id: "same",
        headers: { "cf-connecting-ip": "203.0.113.1" },
      }),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await s.call("slow", {}, {
          session: "j",
          id: "same",
          headers: { "cf-connecting-ip": "203.0.113.2" },
        });
      })(),
    ]);
    assertEquals([a.status, said(a), b.status, own(said(b))], [
      200,
      "Done, slowly.",
      200,
      "Done, slowly.",
    ]);
    assertMatch(said(b), AGAIN);
    assertEquals(runs.slow, 1);
  });
});

test("an answer is cut past the line's result limit", async () => {
  await setup(async (s) => {
    assertEquals(
      said(await s.call("search", { to: "Rio" }, { session: "c" })),
      "2 trips: \n[…cut]",
    );
  }, { line: { limits: { result: 9 } } });
});

test("a conversation its people took the contact out of is over for good", async () => {
  await setup(async (s) => {
    await s.call("pick", { trip: "T1" }, { session: "c" });
    const { contact, thread } = await chatOf("c");
    await s.runtime.call("test.out", { thread, contact });
    const closed = await s.call("peek", {}, { session: "c" });
    assertEquals(closed.body.result?.isError, true);
    assertMatch(said(closed), /over/);
    assertEquals(runs.peek, undefined);
  });
});

test("erased (contact.forget, with its chats or not): the same session comes back to nothing", async () => {
  for (const chats of [true, false]) {
    await setup(async (s) => {
      await s.call("pick", { trip: "T1 (Ana, CPF 123.456.789-01)" }, { session: "ana" });
      const { contact, thread } = await chatOf("ana");
      await s.runtime.call("test.forget", { contact, thread, chats });
      await s.runtime.idle();
      const back = await s.call("peek", {}, { session: "ana" });
      assertMatch(said(back), /over/);
      assertEquals((await s.docs("contact")).length, 0);
      assertEquals((await s.docs("thread")).length, chats ? 0 : 1);
      // What stays says nothing about her: ids that are HMACs.
      const kept = JSON.stringify(await s.docs("mcp_closed"));
      assert(
        !kept.includes("Ana") && !kept.includes("123.456.789-01") && kept.includes("contact:c-"),
      );
    });
  }
});

test("a chat moved to another space: its steps go where it is now", async () => {
  await setup(async (s) => {
    await s.call("search", { to: "Rio" }, { session: "c" });
    const { thread } = await chatOf("c");
    await s.runtime.call("test.move", { thread, to: "review" });
    await s.call("search", { to: "Recife" }, { session: "c" });
    const steps = await s.steps(thread);
    assertEquals(steps.map((m) => m.in), ["line", "review"]);
  });
});

test("mcp.call: only the contact the MCP route makes for that line may call it", async () => {
  await setup(async (s) => {
    const input = { line: "chatgpt", tool: "search", input: { to: "Rio" }, call: "x", by: "new" };
    for (
      const actor of [
        { kind: "contact", id: "c-123456789012" },
        { kind: "contact", id: "c-123456789012", mcp: "other" },
        { kind: "person", id: "ana" },
        { kind: "anonymous", id: "" },
      ]
    ) {
      await assertRejects(
        () => s.runtime.call("mcp.call", input, { actor }),
        Error,
        "may not call",
      );
    }
    assertEquals(runs.search, undefined);
  });
});

test("staff read a conversation's chat as any in their space: its steps, in order", async () => {
  await setup(async (s) => {
    await s.call("search", { to: "Rio" }, { session: "c" });
    await s.call("pick", { trip: "T1" }, { session: "c" });
    const { thread } = await chatOf("c");
    const steps = await s.steps(thread);
    assertEquals(steps.map((m) => (m.toolCalls as Step[])[0].name), ["search", "pick"]);
    const messages = await s.docs<Message>("message", thread);
    assertEquals(messages.every((m) => m.private), true);
  });
});

test("only a contact the MCP route made for a line calls it: a web visitor never, naming a line or not", async () => {
  await setup(async (s) => {
    const visitor = { kind: "contact", id: "c-web-visitor", web: "site" };
    for (
      const input of [
        { line: "chatgpt", tool: "search", input: {}, call: "c", by: "new" },
        { tool: "search", input: {}, call: "c", by: "new" },
        { line: undefined, tool: "search", input: {}, call: "c", by: "new" },
      ]
    ) {
      const error = await assertRejects(() =>
        s.runtime.call("mcp.call", input, { actor: visitor })
      );
      assertEquals((error as { code?: string }).code, "forbidden", JSON.stringify(input));
    }
  });
});

/** What a conversation's contact was under the old scheme: an HMAC with the app's secret itself. */
async function rawContact(secret: string, session: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const parts = ["mcp", "contact", null, SCOPE.line, "session", session, null];
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(parts)));
  return `c-${
    [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24)
  }`;
}

test("ids come from the MCP key of the app's secret, never the secret itself", async () => {
  const { contact } = await chatOf("conv-1");
  assertNotEquals(contact, await rawContact(SECRET, "conv-1"));
  assertMatch(contact, /^c-[0-9a-f]{24}$/);
});

test("the app's secret changed, the one before given: a conversation goes on as itself", async () => {
  const store = memoryStore();
  const NEW = "a-new-secret-for-signing-links-in-tests-0123456789";
  const rotated = (previous?: string) =>
    definePlugin({
      name: "rotated",
      resources: {
        links: { origin: "https://app.example", secret: NEW, ...(previous ? { previous } : {}) },
      },
    });
  const before = await chatOf("conv-1");
  await setup(async (a) => {
    assertEquals(
      said(await a.call("pick", { trip: "Rio 10:30" }, { session: "conv-1" })),
      "Picked Rio 10:30.",
    );
  }, { store });
  await setup(async (b) => {
    // Made under the secret before: the same contact, in the same chat, its booking there.
    const who = JSON.parse(said(await b.call("whoami", {}, { session: "conv-1" })));
    assertEquals([who.id, who.thread], [before.contact, before.thread]);
    assertEquals(said(await b.call("peek", {}, { session: "conv-1" })), "Booked: Rio 10:30");
    assertEquals((await b.steps(before.thread)).length, 3);
    // A new conversation is the new secret's.
    const fresh = JSON.parse(said(await b.call("whoami", {}, { session: "conv-2" })));
    const made = await conversationOf(NEW, SCOPE, { session: "conv-2" });
    assertEquals([fresh.id, fresh.thread], [made.contact, made.thread]);
  }, { store, plugins: [rotated(SECRET)] });
  // The secret before no longer given: what it made is out of reach, a new conversation instead.
  await setup(async (c) => {
    const who = JSON.parse(said(await c.call("whoami", {}, { session: "conv-1" })));
    assertNotEquals(who.id, before.contact);
    assertEquals(said(await c.call("peek", {}, { session: "conv-1" })), "No booking.");
  }, { store, plugins: [rotated()] });
});
