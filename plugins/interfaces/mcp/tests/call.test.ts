/**
 * A tool call and the conversation it belongs to: a contact in a chat of
 * its own, named by ChatGPT's session or a handle the app gave; the tool
 * run as that contact, written as a step, answered as the app's agents
 * read it; errors that say only what's public; a request sent again
 * answered once (tools that change things), or fresh (read-only ones);
 * erasure that sticks; and no way into another conversation.
 */
import { assert, assertEquals, assertMatch, assertNotEquals, assertRejects } from "@std/assert";
import { test } from "../../../../testing/mod.ts";
import type { Message, Step } from "../../../agents/chat/mod.ts";
import { callIdOf, conversationOf } from "../shared/keys.ts";
import { handleIn, runs, said, SECRET, setup, state } from "./setup.ts";

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

test("the tool runs as the contact: its client, its chat; its callId the call's, its trigger the step", async () => {
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
    assertEquals([who.trigger, who.callId, who.retry], [step._id, call.id, false]);
  });
});

test("a request's id is hashed into the call's: what a client sends never reaches a tool as it came", async () => {
  await setup(async (s) => {
    const evil = "../../v1/orders/123?refund=1\r\nX-Evil: 1";
    const who = JSON.parse(said(await s.call("whoami", {}, { session: "c", id: evil })));
    assertMatch(who.callId, /^mcp:mcp-[0-9a-f]{32}:[0-9a-f]{16}:[0-9a-f]{16}$/);
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
    assertEquals(said(again), said(first));
    assertEquals(runs.pick, 1);
    const { thread } = await chatOf("c");
    assertEquals((await s.steps(thread)).length, 1);
    // A client that numbers each call from 1: the same id, asking something else, runs.
    assertEquals(said(await s.call("pick", { trip: "T2" }, { session: "c", id: 7 })), "Picked T2.");
    assertEquals(runs.pick, 2);
    await s.call("boom", {}, { session: "c", id: 8 });
    const boomAgain = await s.call("boom", {}, { session: "c", id: 8 });
    assertEquals([boomAgain.body.result?.isError, runs.boom], [true, 1]);
    // Two minutes after its answer, the same request is asked again for a reason: it runs.
    await s.runtime.call("test.age", { ms: 121_000 });
    await s.call("pick", { trip: "T1" }, { session: "c", id: 7 });
    assertEquals(runs.pick, 3);
    const names = (await s.steps(thread)).map((m) => (m.toolCalls as Step[])[0].name);
    assertEquals(names, ["pick", "pick", "boom", "pick"]);
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
    await s.runtime.call("test.cut", { call, step: `${call}@cut` });
    const who = JSON.parse(said(await s.call("whoami", {}, { session: "c", id: 5 })));
    assertEquals([who.callId, who.trigger, who.retry], [call, `${call}@cut`, true]);
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
    assertEquals([said(a), said(b)], ["Done, slowly.", "Done, slowly."]);
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

test("limits by address: as the app's front says it, only with its secret; exempt ranges aren't", async () => {
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
    // Without the front's secret, the header is anyone's: not believed, no address limit.
    const forged = await s.call("search", { to: "A" }, {
      session: "a3",
      ...from("203.0.113.9", "wrong"),
    });
    assertEquals(said(forged).slice(0, 7), "2 trips");
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
        { kind: "visitor", id: "" },
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
