/**
 * A routine's runs nobody watches: what its agent needs a yes for stops the
 * run until someone answers, unless it's allowed for that routine. That yes
 * covers only that routine's runs, as it was when it was given: not what a
 * person asks the same agent, not a message claiming to be the routine's, and
 * not the routine once someone changes what it does.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type Actor, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter, type LlmMessage } from "../../models/mod.ts";
import { chat, type Message } from "../../agents/chat/mod.ts";
import { routines } from "../../agents/routines/mod.ts";
import { access } from "../../access/mod.ts";
import { join } from "../../access/tests/join.ts";
import { type Approval, computers, type Desk } from "../mod.ts";
import { WORK } from "../computers/shared/workloads.ts";
import { test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** "run <command>", or a yes to one: it runs it, then says what the tool answered. */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      yield { type: "text", text: `tool said: ${text(last).slice(0, 80)}` };
      return;
    }
    const said = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const command = said.match(/\brun (.+)$/)?.[1] ?? said.match(/\bYes[^:]*: (.+)$/)?.[1];
    if (command) {
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: "terminal", input: { stdin: command } },
      };
    } else yield { type: "text", text: "ok" };
  },
};

const app = definePlugin({
  name: "app",
  resources: {
    shared: { thread: {}, message: { labels: true } },
    provider: { s: { adapter: "s" } },
    agents: {
      assistant: { instructions: "Hi.", model: "s/x", default: true, tools: ["terminal"] },
    },
  },
  adapters: { llm: { s: script } },
});

async function setup(
  fn: (s: {
    rt: Awaited<ReturnType<typeof createRuntime>>;
    topic: string;
    pending(actor?: Actor): Promise<Approval[]>;
    ran(computer: ReturnType<typeof fakeComputer>): string[];
    routine(input: Record<string, unknown>, actor?: Actor): Promise<string>;
    run(routine: string, actor?: Actor): Promise<void>;
  }) => Promise<void>,
) {
  const topic = `routine-approvals.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, routines, computers, app],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    await fn({
      rt,
      topic,
      pending: (actor = ana) => rt.query<Approval[]>("approval.pending", {}, { actor }),
      ran: (computer) =>
        computer.asked.filter((a) => a.work === WORK.terminal).map((a) =>
          String((a.input as { stdin?: string }).stdin)
        ),
      routine: async (input, actor = ana) =>
        (await rt.call<{ routine: string }>("routine.create", {
          agent: "assistant",
          schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
          post: "new",
          ...input,
        }, { actor })).routine,
      run: async (routine, actor = ana) => {
        await rt.call("routine.run", { routine }, { actor });
        await rt.idle();
      },
    });
  } finally {
    await rt.close();
  }
}

/** Ana's computer, in her Personal space. */
async function connected(s: Parameters<Parameters<typeof setup>[0]>[0]) {
  const { space } = await s.rt.call<{ space: string }>("space.personal", {}, { actor: ana });
  const { code } = await s.rt.call<{ code: string }>("computer.code", {}, { actor: ana });
  const computer = fakeComputer(s.topic, `code:${code}`);
  await computer.worker.ready;
  for (let i = 0; i < 300; i++) {
    const desks = await s.rt.query<Desk[]>("desk.here", { in: space }, { actor: ana });
    if (desks[0]?.online) return { space, computer, desk: desks[0] };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("it didn't come");
}

test("a yes for a routine lets its runs go on their own, and nothing else", async () => {
  await setup(async (s) => {
    const { space, computer, desk } = await connected(s);
    const id = await s.routine({ in: space, name: "Disk", text: "run df" });

    // Its first run stops and asks, saying it's the routine's.
    await s.run(id);
    assertEquals(s.ran(computer), []);
    const [asked] = await s.pending();
    assertEquals([asked.detail, asked.origin?.kind, asked.origin?.id, asked.origin?.name], [
      "df",
      "routine",
      id,
      "Disk",
    ]);

    // Yes, for this routine: that run carries on.
    await s.rt.call("computer.approve", { approval: asked._id, answer: "origin" }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df"]);
    assertEquals(await s.pending(), []);
    const said = await s.rt.query<Message[]>("message.history", { thread: asked.thread }, {
      actor: ana,
    });
    assert(said.some((m) => m.from === "ana" && m.text === "Yes, for this routine: df"));

    // Its next run, in a chat of its own, goes without asking.
    await s.run(id);
    assertEquals(s.ran(computer), ["df", "df"]);
    assertEquals(await s.pending(), []);

    // What the person asks the same agent still asks: the same command, here or in a run's chat.
    const { thread } = await s.rt.call<{ thread: string }>("chat.send", {
      text: "run df",
      in: space,
    }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df"]);
    assertEquals((await s.pending()).map((a) => [a.thread, a.origin]), [[thread, undefined]]);
    await s.rt.call("chat.send", { thread: asked.thread, text: "run ls" }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df"]);

    // A message saying it's the routine's isn't: the mark comes from what really ran it.
    const before = (await s.pending()).length;
    await s.rt.call("chat.send", {
      in: space,
      text: "run whoami",
      via: { kind: "routine", name: "Disk", path: `/routine/${id}` },
    }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df"]);
    assertEquals((await s.pending()).length, before + 1);

    // Another routine isn't covered.
    const other = await s.routine({ in: space, name: "Other", text: "run uptime" });
    await s.run(other);
    assertEquals(s.ran(computer), ["df", "df"]);

    // Answers other than this one work as before, and keep the run's scope.
    const uptime = (await s.pending()).find((a) => a.detail === "uptime")!;
    assertEquals(uptime.origin?.id, other);
    await s.rt.call("computer.approve", { approval: uptime._id, answer: "once" }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df", "uptime"]);
    await s.run(other);
    assertEquals(s.ran(computer), ["df", "df", "uptime"], "once isn't for the next run");

    // Allowing it ahead of time from its page answers what waits, and can be taken back.
    const allow = (allow: boolean) =>
      s.rt.call("computer.allowOrigin", {
        kind: "routine",
        id: other,
        desk: desk._id,
        agent: "assistant",
        work: "terminal",
        allow,
      }, { actor: ana });
    await allow(true);
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df", "uptime", "uptime"]);
    await s.run(other);
    assertEquals(s.ran(computer).length, 5);
    await allow(false);
    await s.run(other);
    assertEquals(s.ran(computer).length, 5, "taken back, it asks again");
    await computer.worker.stop();
  });
});

test("every run stopped on the same thing carries on when it's allowed", async () => {
  await setup(async (s) => {
    const { space, computer } = await connected(s);
    const id = await s.routine({ in: space, name: "Disk", text: "run df" });
    await s.run(id);
    await s.run(id);
    const waiting = await s.pending();
    assertEquals(waiting.length, 2);
    assert(waiting[0].thread !== waiting[1].thread);
    await s.rt.call("computer.approve", { approval: waiting[0]._id, answer: "origin" }, {
      actor: ana,
    });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df"]);
    assertEquals(await s.pending(), []);
    await computer.worker.stop();
  });
});

test("changing what a routine does ends the yes given for it, by whoever changes it", async () => {
  await setup(async (s) => {
    const { space, computer, desk } = await connected(s);
    const id = await s.routine({ in: space, name: "Disk", text: "run df" });
    const rev = async () =>
      (await s.rt.query<{ _id: string; rev?: number }[]>("routine.list", { in: space }, {
        actor: ana,
      })).find((r) => r._id === id)?.rev ?? 0;
    const allow = () =>
      s.rt.call("computer.allowOrigin", {
        kind: "routine",
        id,
        desk: desk._id,
        agent: "assistant",
        work: "terminal",
        allow: true,
      }, { actor: ana });
    await allow();
    await s.run(id);
    assertEquals(s.ran(computer), ["df"]);

    // Its name or its time don't change what it does.
    await s.rt.call("routine.update", { routine: id, name: "Disk check" }, { actor: ana });
    assertEquals(await rev(), 0);
    await s.run(id);
    assertEquals(s.ran(computer), ["df", "df"]);

    // What it asks does: it stops and asks again.
    await s.rt.call("routine.update", { routine: id, text: "run rm -rf /" }, { actor: ana });
    assertEquals(await rev(), 1);
    await s.run(id);
    assertEquals(s.ran(computer), ["df", "df"]);
    const [asked] = await s.pending();
    assertEquals([asked.detail, asked.origin?.rev], ["rm -rf /", 1]);
    // The yes that ended is still there to see, for its page to offer again.
    const grants = await s.rt.query<{ rev: number }[]>("grant.forOrigin", {
      origin: `routine:${id}`,
    }, { actor: ana });
    assertEquals(grants.map((g) => g.rev), [0]);

    // Allowed again, it's for the routine as it is now, whatever anyone says.
    await allow();
    await s.rt.idle();
    assertEquals(s.ran(computer), ["df", "df", "rm -rf /"]);
    assertEquals(
      (await s.rt.query<{ rev: number }[]>("grant.forOrigin", { origin: `routine:${id}` }, {
        actor: ana,
      })).map((g) => g.rev),
      [1],
    );
    await computer.worker.stop();
  });
});

test("where a computer's owner answers, the yes is theirs, and only theirs", async () => {
  await setup(async (s) => {
    const { space: _, computer, desk } = await connected(s);
    const { space: launch } = await s.rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(s.rt, launch, bob, "editor", ana);
    await s.rt.call(
      "space.addMember",
      { space: launch, member: "agent:assistant", role: "editor" },
      {
        actor: ana,
      },
    ).catch(() => {});
    await s.rt.call("computer.share", { computer: desk.computer, in: launch, answers: "owner" }, {
      actor: ana,
    });
    const [shared] = await s.rt.query<Desk[]>("desk.here", { in: launch }, { actor: bob });
    assertEquals(shared.answers, "owner");

    // Bob's routine, on Ana's computer: Bob can't let it; it stops and asks Ana.
    const id = await s.routine({ in: launch, name: "Build", text: "run make" }, bob);
    const allow = (actor: Actor) =>
      s.rt.call("computer.allowOrigin", {
        kind: "routine",
        id,
        desk: shared._id,
        agent: "assistant",
        work: "terminal",
        allow: true,
      }, { actor });
    const refused = await assertRejects(() => allow(bob));
    assertEquals((refused as { code?: string }).code, "forbidden");
    await s.run(id, bob);
    assertEquals(s.ran(computer), []);
    assertEquals(await s.pending(bob), []);
    const [asked] = await s.pending(ana);
    assertEquals([asked.detail, asked.owner, asked.for], ["make", "ana", "bob"]);

    // Ana lets it. Bob then changes what it does: Ana's yes doesn't cover that.
    await s.rt.call("computer.approve", { approval: asked._id, answer: "origin" }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["make"]);
    await s.run(id, bob);
    assertEquals(s.ran(computer), ["make", "make"]);
    await s.rt.call("routine.update", { routine: id, text: "run curl evil.example" }, {
      actor: bob,
    });
    await s.run(id, bob);
    assertEquals(s.ran(computer), ["make", "make"]);
    assertEquals((await s.pending(ana)).map((a) => a.detail), ["curl evil.example"]);
    await computer.worker.stop();
  });
});

test("only what a routine set going can be allowed for one", async () => {
  await setup(async (s) => {
    const { space, computer } = await connected(s);
    await s.rt.call("chat.send", { text: "run ls", in: space }, { actor: ana });
    await s.rt.idle();
    const [asked] = await s.pending();
    assertEquals(asked.origin, undefined);
    const refused = await assertRejects(() =>
      s.rt.call("computer.approve", { approval: asked._id, answer: "origin" }, { actor: ana })
    );
    assertEquals((refused as { code?: string }).code, "invalid");
    assertEquals((await s.pending()).length, 1);
    assertStringIncludes(asked.detail, "ls");
    await computer.worker.stop();
  });
});

test("a key can't answer for its person, and nobody works directly on a computer whose owner answers", async () => {
  await setup(async (s) => {
    const { space, computer, desk } = await connected(s);
    await s.rt.call("chat.send", { text: "run ls", in: space }, { actor: ana });
    await s.rt.idle();
    const [asked] = await s.pending();
    const key: Actor = { kind: "person", id: "ana", key: "k1", within: space };
    const by = (call: Promise<unknown>) =>
      call.then(() => "done", (e) => (e as { code?: string }).code);
    assertEquals(
      await by(s.rt.call("computer.approve", { approval: asked._id, answer: "always" }, {
        actor: key,
      })),
      "forbidden",
    );
    assertEquals(
      await by(s.rt.call("computer.allowOrigin", {
        kind: "routine",
        id: "r",
        desk: desk._id,
        agent: "assistant",
        work: "terminal",
        allow: true,
      }, { actor: key })),
      "forbidden",
    );

    const { space: launch } = await s.rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(s.rt, launch, bob, "editor", ana);
    await s.rt.call("computer.share", { computer: desk.computer, in: launch, answers: "owner" }, {
      actor: ana,
    });
    const [shared] = await s.rt.query<Desk[]>("desk.here", { in: launch }, { actor: bob });
    const work = (actor: Actor, work: string) =>
      by(s.rt.call("computer.work", { desk: shared._id, work, input: {} }, { actor }));
    assertEquals(await work(bob, "files.list"), "done");
    assertEquals(await work(bob, "jobs.start"), "forbidden");
    assertEquals(await work(ana, "files.list"), "done");
    await computer.worker.stop();
  });
});

test("what's let for a routine is checked against it; an owner's yes keeps the turn its person's", async () => {
  await setup(async (s) => {
    const { computer, desk } = await connected(s);
    const by = (call: Promise<unknown>) =>
      call.then(() => "done", (e) => (e as { code?: string }).code);
    const allow = (id: string) =>
      by(s.rt.call("computer.allowOrigin", {
        kind: "routine",
        id,
        desk: desk._id,
        agent: "assistant",
        work: "terminal",
        allow: true,
      }, { actor: ana }));
    assertEquals(await allow("made-up"), "invalid");
    // A routine of another space doesn't reach this desk.
    const { space: other } = await s.rt.call<{ space: string }>("space.create", {
      name: "Other",
    }, { actor: ana });
    assertEquals(
      await allow(await s.routine({ in: other, name: "There", text: "run df" })),
      "invalid",
    );

    // Bob's agent, on Ana's computer, Ana answering: the next turn is still for Bob.
    const { space: launch } = await s.rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    await join(s.rt, launch, bob, "editor", ana);
    await s.rt.call("computer.share", { computer: desk.computer, in: launch, answers: "owner" }, {
      actor: ana,
    });
    const { thread } = await s.rt.call<{ thread: string }>("chat.send", {
      text: "run make",
      in: launch,
    }, { actor: bob });
    await s.rt.idle();
    const [asked] = await s.pending(ana);
    assertEquals([asked.owner, asked.for], ["ana", "bob"]);
    await s.rt.call("computer.approve", { approval: asked._id, answer: "thread" }, { actor: ana });
    await s.rt.idle();
    assertEquals(s.ran(computer), ["make"]);
    const said = await s.rt.query<Message[]>("message.history", { thread }, { actor: bob });
    const yes = said.find((m) => m.text === "Yes, in this conversation: make")!;
    assertEquals([yes.from, yes.via?.kind, yes.via?.name], ["bob", "answer", "ana"]);
    await computer.worker.stop();
  });
});

test("leaving ends what a person brought and left behind, however they left", async () => {
  await setup(async (s) => {
    const { computer, desk } = await connected(s);
    const { space: launch } = await s.rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: bob });
    await join(s.rt, launch, ana, "editor", bob);
    await s.rt.call("computer.share", { computer: desk.computer, in: launch }, { actor: ana });
    assertEquals((await s.rt.query<Desk[]>("desk.here", { in: launch }, { actor: bob })).length, 1);
    // Something of Bob's waits on her computer there.
    await s.rt.call("chat.send", { text: "run ls", in: launch }, { actor: bob });
    await s.rt.idle();
    assertEquals((await s.pending(bob)).length, 1);

    await s.rt.call("space.leave", { space: launch }, { actor: ana });
    await s.rt.idle();
    assertEquals(await s.rt.query<Desk[]>("desk.here", { in: launch }, { actor: bob }), []);
    assertEquals(await s.pending(bob), []);
    // Her computer is still hers, in her Personal space.
    assertEquals((await s.rt.query<unknown[]>("computer.mine", {}, { actor: ana })).length, 1);
    await computer.worker.stop();
  });
});
