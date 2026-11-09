/**
 * Who, for whom, where, whichever way the work came in. North working for
 * Ana in Launch reaches Launch alone (not Finance, nor Ana's Personal space,
 * though Ana reaches both and North works in all three), and its tools know
 * where they are: asked from a host, Ana's page (one that says it's
 * elsewhere, too), her terminal, her routine, her key, or handed over from
 * another of her chats. In her Personal space, which only she sees, it
 * reaches all she does.
 */
import { assertEquals } from "@std/assert";
import { Writable } from "node:stream";
import { type Actor, connect, createRuntime, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models, { type LlmAdapter } from "../../models/mod.ts";
import { chat, tool } from "../../agents/chat/mod.ts";
import { chatTerminal } from "../../agents/chat/terminal.ts";
import { routines } from "../../agents/routines/mod.ts";
import { api } from "../../interfaces/api/mod.ts";
import { terminalPlugin } from "../../interfaces/terminal/mod.ts";
import { terminalShell } from "../../interfaces/terminal/terminal.ts";
import { terminal } from "../../../hosts/terminal/mod.ts";
import { access } from "../mod.ts";
import { accessTerminal } from "../spaces/terminal.ts";
import { test, testWho, ticketFor } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

/** What each probe saw: who, for whom, where, and the notes it reached. */
type Probe = { who: unknown[]; in?: string; notes: string[] };
const probes: Probe[] = [];

/** "hand <space>" hands a probe over there; anything else, a probe here. */
const scripted: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.findLast((m) => !("text" in m && m.text?.startsWith("<context")))!;
    if (last.role === "tool") return yield { type: "text", text: "done" };
    const said = "text" in last ? last.text ?? "" : "";
    const hand = /hand (\S+)$/.exec(said);
    yield {
      type: "tool_call",
      call: hand
        ? { id: "h", name: "send_message", input: { space: hand[1], text: "probe" } }
        : { id: "p", name: "probe", input: {} },
    };
  },
};

const app = definePlugin({
  name: "app",
  collections: {
    note: {
      schema: { type: "object", properties: { in: { type: "string" }, text: { type: "string" } } },
    },
  },
  actions: {
    "note.add": {
      input: { type: "object" },
      run: (ctx, input) => ctx.db.collection("note").insertOne(input as Record<string, unknown>),
    },
  },
  resources: {
    shared: { note: {} },
    provider: { s: { adapter: "s" } },
    agents: {
      north: {
        instructions: "Hi.",
        model: "s/north",
        default: true,
        tools: ["probe", "send_message"],
      },
    },
    tools: {
      probe: tool({
        description: "Says who and where it works, and what it reaches.",
        run: async (_, ctx) => {
          const notes = await ctx.db.collection<{ text: string }>("note").find({});
          probes.push({
            who: [ctx.actor?.kind, ctx.actor?.id, (ctx.actor?.for as Actor | undefined)?.id],
            ...(ctx.in ? { in: ctx.in } : {}),
            notes: notes.map((n) => n.text).sort(),
          });
          return "probed";
        },
      }),
    },
  },
  adapters: { llm: { s: scripted } },
});

test("the same who, for whom and where reach the same, whichever way they came in", async () => {
  const topic = `where-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [
      models,
      chat,
      ...access,
      routines,
      api,
      terminalPlugin,
      app,
      terminalShell,
      chatTerminal,
      accessTerminal,
      testWho,
    ],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const browser = connect({
    transport: { type: "in-process", config: { topic } },
    ticket: () => ticketFor(rt, ana),
    plugins: [],
  });
  try {
    // Ana's Personal space, Launch and Finance; North (the app's agent) works in all three.
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const { space: launch } = await rt.call<{ space: string }>("space.create", {
      name: "Launch",
    }, { actor: ana });
    const { space: finance } = await rt.call<{ space: string }>("space.create", {
      name: "Finance",
    }, { actor: ana });
    for (const [space, text] of [[personal, "mine"], [launch, "plan"], [finance, "budget"]]) {
      await rt.call("note.add", { in: space, text });
    }
    const probed = async (way: string, start: () => Promise<unknown>) => {
      probes.length = 0;
      await start();
      await rt.idle();
      const there = probes.filter((p) => p.in === launch);
      assertEquals(there.length, 1, `${way}: one probe in Launch (${JSON.stringify(probes)})`);
      return [way, there[0]] as const;
    };
    const expected = { who: ["agent", "north", "ana"], in: launch, notes: ["plan"] };

    const ways = [
      // A host calling as her.
      await probed(
        "host",
        () => rt.call("chat.send", { in: launch, text: "probe" }, { actor: ana }),
      ),
      // Her page, saying it's elsewhere (her Personal space): the chat is in Launch.
      await probed("page", async () => {
        await browser.ready;
        await browser.call("chat.send", { in: launch, text: "probe" }, { in: personal });
      }),
      // Her terminal, working in Launch.
      await probed("terminal", () =>
        terminal({
          runtime: rt,
          me: "ana",
          actor: ana,
          space: launch,
          stdout: Object.assign(new Writable({ write: (_c, _e, done) => done() }), {
            columns: 120,
            isTTY: false,
          }),
          input: (async function* () {
            yield "probe";
          })(),
        })),
      // Her routine in Launch, run now.
      await probed("routine", async () => {
        const { routine } = await rt.call<{ routine: string }>("routine.create", {
          in: launch,
          text: "probe",
          agent: "north",
          schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
          post: "new",
        }, { actor: ana });
        await rt.call("routine.run", { routine }, { actor: ana });
      }),
      // Her key, made in Launch.
      await probed("key", async () => {
        const { key } = await rt.call<{ key: string }>("api_key.create", {
          in: launch,
          name: "Script",
          scope: { call: ["chat.send"] },
        }, { actor: ana });
        const sent = await rt.fetch(
          new Request("http://localhost/api/actions/chat.send", {
            method: "POST",
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ in: launch, text: "probe" }),
          }),
        );
        if (!sent.ok) throw new Error(`key: ${sent.status} ${await sent.text()}`);
      }),
      // Handed over from her Personal chat.
      await probed(
        "hand-over",
        () => rt.call("chat.send", { in: personal, text: `hand ${launch}` }, { actor: ana }),
      ),
    ];
    for (const [way, probe] of ways) {
      // A key's agent works for its key: its person, through it.
      assertEquals({ ...probe, who: probe.who.slice(0, 3) }, expected, way);
    }

    // In her Personal space, which only she sees, it reaches all she does.
    probes.length = 0;
    await rt.call("chat.send", { in: personal, text: "probe" }, { actor: ana });
    await rt.idle();
    assertEquals(probes, [{
      who: ["agent", "north", "ana"],
      in: personal,
      notes: ["budget", "mine", "plan"],
    }]);
  } finally {
    await browser.close();
    await rt.close();
  }
});
