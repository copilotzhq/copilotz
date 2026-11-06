/**
 * Documents in spaces: people's saves are versions, merged line by line
 * when two save at once and refused when they changed the same lines;
 * restoring, renaming, deleting; who has one open; the rules (outsiders see
 * nothing, viewers only read, and from outside, through the REST API or a
 * browser's socket, nothing is written but by the Actions); and agents'
 * tools end to end, driven by a scripted model, each change a version of
 * the agent's.
 */
import assert from "node:assert/strict";
import {
  type Actor,
  createRuntime,
  defineAction,
  definePlugin,
  type Store,
} from "../../../../runtime/mod.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { postgresStore } from "../../../../stores/sql/postgres/mod.ts";
import { models } from "../../../models/mod.ts";
import type { LlmAdapter, LlmMessage } from "../../../models/mod.ts";
import { chat } from "../../../agents/mod.ts";
import { access } from "../../../access/mod.ts";
import { env, temporary, test } from "../../../../testing/mod.ts";
import { type Document, documents, type Listed, type Presence, type Saved } from "../mod.ts";
import { nameOf } from "../shared/who.ts";

const POSTGRES = env("COPILOTZ_TEST_POSTGRES_URL");
const stores: Record<string, () => Store | Promise<Store>> = {
  memory: memoryStore,
  ...(POSTGRES
    ? {
      postgres: () =>
        temporary(postgresStore({ url: POSTGRES, schema: `d_${crypto.randomUUID().slice(0, 8)}` })),
    }
    : {}),
};

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const vera: Actor = { kind: "person", id: "vera" };
const carl: Actor = { kind: "person", id: "carl" };

const text = (m: LlmMessage) => "text" in m ? m.text ?? "" : "";

/** What the tools answered, in order. */
let outputs: string[] = [];

/** `call <tool> <json>` calls that tool with that input; then it says "done". */
const script: LlmAdapter = {
  async *generate({ messages }) {
    const last = messages.at(-1)!;
    if (last.role === "tool") {
      outputs.push(text(last));
      yield { type: "text", text: "done" };
      return;
    }
    const said = text(messages.filter((m) => !text(m).startsWith("<context")).at(-1)!);
    const asked = said.match(/call (\w+) (\{[\s\S]*\})\s*$/);
    if (asked) {
      yield {
        type: "tool_call",
        call: { id: crypto.randomUUID(), name: asked[1], input: JSON.parse(asked[2]) },
      };
    } else yield { type: "text", text: "ok" };
  },
};

/** Reads a collection as an actor, under the rules: what a browser's direct read gets. */
const peek = defineAction({
  input: {
    type: "object",
    properties: { collection: { type: "string" }, filter: { type: "object" } },
    required: ["collection"],
  },
  allow: () => true,
  run: (ctx, { collection, filter }) => ctx.db.collection(collection).find(filter ?? {}),
});

async function start(make: () => Store | Promise<Store>) {
  outputs = [];
  return await createRuntime({
    store: await make(),
    plugins: [
      models,
      chat,
      ...access,
      documents,
      definePlugin({
        name: "app",
        actions: { "test.peek": peek },
        resources: {
          shared: { thread: {}, message: { labels: true } },
          provider: { s: { adapter: "s" } },
          agents: {
            lead: { instructions: "I lead.", model: "s/one", default: true, name: "Lead" },
          },
        },
        adapters: { llm: { s: script } },
      }),
    ],
  });
}

type Rt = Awaited<ReturnType<typeof start>>;

/** Lets someone into a space as people join: invited by email by a manager, then accepting. */
async function join(rt: Rt, space: string, who: Actor, role: string) {
  const email = `${who.id}@example.com`;
  await rt.call("person.set", { person: who.id, email });
  const { invitation } = await rt.call<{ invitation: string }>("invitation.send", {
    space,
    email,
    role,
  }, { actor: ana });
  await rt.call("invitation.accept", { invitation }, { actor: who });
}

/** The error a call failed with. */
async function refused(call: Promise<unknown>): Promise<Error & { code?: string }> {
  let result: unknown;
  try {
    result = await call;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error(`It was expected to fail, and didn't: ${JSON.stringify(result)}`);
}

type Written = {
  document: string;
  version: number;
  added: number;
  removed: number;
  merged?: boolean;
  unchanged?: true;
  text?: string;
};

for (const [name, make] of Object.entries(stores)) {
  test(`${name}: every save a version; two at once merge, or clash on the same lines`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      await join(rt, space, bob, "editor");
      const made = await rt.call<Written>("document.create", { in: space, title: " Plan " }, {
        actor: ana,
      });
      assert.equal(made.version, 1);
      const doc = made.document;
      const save = (who: Actor, base: number, body: string, title?: string) =>
        rt.call<Written>("document.save", {
          document: doc,
          base,
          text: body,
          ...(title !== undefined ? { title } : {}),
        }, { actor: who });

      const first = await save(ana, 1, "Goal: ship\n\nOwner: ana");
      assert.deepEqual([first.version, first.added, first.removed], [2, 3, 0]);
      const same = await save(ana, 2, "Goal: ship\n\nOwner: ana");
      assert.equal(same.unchanged, true, "the same text saved again is a version");
      assert.equal(same.version, 2);

      // Bob and Ana both start from version 2; Bob saves first.
      const bobs = await save(bob, 2, "Goal: ship\n\nOwner: bob");
      assert.equal(bobs.version, 3);
      const anas = await save(ana, 2, "Goal: ship the beta\n\nOwner: ana");
      assert.equal(anas.merged, true);
      assert.equal(anas.version, 4);
      assert.equal(anas.text, "Goal: ship the beta\n\nOwner: bob");

      // Changing the line Bob changed, from before he did: refused, nothing written.
      const clash = await refused(save(ana, 2, "Goal: ship\n\nOwner: cy"));
      assert.equal(clash.code, "conflict");
      assert.match(clash.message, /saved version 4 since you started from version 2/);
      const [now] = await rt.call<Document[]>("test.peek", {
        collection: "document",
        filter: { _id: doc },
      }, { actor: ana });
      assert.equal(now.version, 4);
      assert.equal(now.text, "Goal: ship the beta\n\nOwner: bob");
      assert.equal(now.savedBy, "person:ana");
      assert.equal(now.createdBy, "person:ana");

      // Kept over theirs: saved from the version that's there now.
      const kept = await save(ana, 4, "Goal: ship\n\nOwner: cy");
      assert.equal(kept.version, 5);

      // Titles merge whole: one side renames, the other edits; both rename differently, conflict.
      const renamed = await save(bob, 5, "Goal: ship\n\nOwner: cy", "Launch plan");
      assert.equal(renamed.version, 6);
      const edited = await save(ana, 5, "Goal: ship it\n\nOwner: cy", "Plan");
      assert.equal(edited.merged, true);
      const titled = await rt.call<Document[]>("test.peek", {
        collection: "document",
        filter: { _id: doc },
      }, { actor: ana });
      assert.equal(titled[0].title, "Launch plan");
      await save(bob, 7, "Goal: ship it\n\nOwner: cy", "Bob's plan");
      assert.equal(
        (await refused(save(ana, 7, "Goal: ship it\n\nOwner: cy", "Ana's"))).code,
        "conflict",
      );

      const history = await rt.query<Saved[]>("documentVersion.history", { document: doc }, {
        actor: ana,
      });
      assert.deepEqual(history.map((v) => v.version), [8, 7, 6, 5, 4, 3, 2, 1]);
      assert.equal((history as Record<string, unknown>[])[0].text, undefined, "history has texts");
      const four = history.find((v) => v.version === 4)!;
      assert.deepEqual([four.kind, four.merged, four.base, four.by], [
        "save",
        true,
        2,
        "person:ana",
      ]);
      assert.equal(history.at(-1)!.kind, "create");
      assert.equal(history.find((v) => v.version === 6)!.renamed, "Plan");

      // Restoring version 2 makes version 9, as it was then.
      const back = await rt.call<Written>("document.restore", { document: doc, version: 2 }, {
        actor: bob,
      });
      assert.equal(back.version, 9);
      const restored = (await rt.call<Saved[]>("test.peek", {
        collection: "documentVersion",
        filter: { document: doc, version: 9 },
      }, { actor: ana }))[0] as Saved & { text: string };
      assert.deepEqual([restored.kind, restored.from, restored.title, restored.text], [
        "restore",
        2,
        "Plan",
        "Goal: ship\n\nOwner: ana",
      ]);
      assert.equal(
        (await refused(rt.call("document.restore", { document: doc, version: 40 }, { actor: bob })))
          .code,
        "not_found",
      );

      const re = await rt.call<Written>("document.rename", { document: doc, title: "Plan B" }, {
        actor: ana,
      });
      assert.equal(re.version, 10);

      // Too much text is refused, whole.
      const big = await refused(save(ana, 10, "x".repeat(101 * 1024)));
      assert.equal(big.code, "too_large");
      assert.equal((await refused(save(ana, 11, "ahead"))).code, "invalid");

      const listed = await rt.query<Listed[]>("document.list", { in: space }, { actor: bob });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].title, "Plan B");
      assert.equal(listed[0].excerpt, "Goal: ship · Owner: ana");
      assert.equal((listed[0] as Record<string, unknown>).text, undefined);
      const recent = await rt.query<Listed[]>("document.recent", {}, { actor: bob });
      assert.deepEqual(recent.map((d) => d._id), [doc]);

      const gone = await rt.call<{ deleted: boolean; versions: number }>("document.delete", {
        document: doc,
      }, { actor: bob });
      assert.deepEqual(gone.versions, 10);
      assert.deepEqual(await rt.query("document.list", { in: space }, { actor: ana }), []);
      assert.deepEqual(
        await rt.call("test.peek", { collection: "documentVersion", filter: { document: doc } }, {
          actor: ana,
        }),
        [],
      );
      assert.equal(
        (await refused(save(ana, 10, "anything"))).code,
        "not_found",
      );
    } finally {
      await rt.close();
    }
  });

  test(`${name}: outsiders see no documents of a space; viewers read, can't write`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      await join(rt, space, vera, "viewer");
      await rt.call("person.set", { person: "carl", email: "carl@example.com" });
      const { document: doc } = await rt.call<Written>("document.create", {
        in: space,
        title: "Plan",
        text: "Secret plan",
      }, { actor: ana });
      const page = "tab1";

      // Carl isn't in the space: nothing to see, nothing to change.
      assert.deepEqual(await rt.query("document.list", { in: space }, { actor: carl }), []);
      assert.deepEqual(await rt.query("document.recent", {}, { actor: carl }), []);
      assert.deepEqual(
        await rt.query("documentVersion.history", { document: doc }, { actor: carl }),
        [],
      );
      assert.deepEqual(
        await rt.call("test.peek", { collection: "document", filter: { _id: doc } }, {
          actor: carl,
        }),
        [],
      );
      for (
        const [action, input] of [
          ["document.save", { document: doc, base: 1, text: "mine now" }],
          ["document.rename", { document: doc, title: "Mine" }],
          ["document.restore", { document: doc, version: 1 }],
          ["document.delete", { document: doc }],
        ] as const
      ) {
        assert.equal((await refused(rt.call(action, input, { actor: carl }))).code, "not_found");
      }
      assert.equal(
        (await refused(rt.call("document.create", { in: space, title: "Mine" }, { actor: carl })))
          .code,
        "forbidden",
      );
      assert.deepEqual(
        await rt.call("document.presence", { document: doc, page, state: "open" }, {
          actor: carl,
        }),
        { present: false },
      );

      // Vera reads it, and can't change it.
      await rt.call("document.save", { document: doc, base: 1, text: "Secret plan, v2" }, {
        actor: ana,
      });
      const seen = await rt.query<Listed[]>("document.list", { in: space }, { actor: vera });
      assert.deepEqual(seen.map((d) => d.title), ["Plan"]);
      for (
        const [action, input] of [
          ["document.save", { document: doc, base: 2, text: "mine now" }],
          ["document.rename", { document: doc, title: "Mine" }],
          ["document.restore", { document: doc, version: 1 }],
          ["document.delete", { document: doc }],
          ["document.create", { in: space, title: "Mine" }],
        ] as const
      ) {
        const error = await refused(rt.call(action, input, { actor: vera }));
        assert.equal(error.code, "forbidden", `${action}: ${error.message}`);
      }
      const [still] = await rt.call<Document[]>("test.peek", {
        collection: "document",
        filter: { _id: doc },
      }, { actor: ana });
      assert.deepEqual([still.version, still.text, still.title], [2, "Secret plan, v2", "Plan"]);

      // Viewers say they're there, as anyone who reads it.
      await rt.call("document.presence", { document: doc, page, state: "open" }, { actor: vera });
      const present = await rt.call<Presence[]>("test.peek", {
        collection: "documentPresence",
        filter: { document: doc },
      }, { actor: ana });
      assert.deepEqual(present.map((p) => [p.who, p.state]), [["person:vera", "open"]]);
      assert.deepEqual(
        await rt.call("test.peek", { collection: "documentPresence", filter: {} }, {
          actor: carl,
        }),
        [],
      );
    } finally {
      await rt.close();
    }
  });

  test(`${name}: who has a document open, who's editing it, and gone when they leave`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      await join(rt, space, bob, "editor");
      const { document: doc } = await rt.call<Written>("document.create", {
        in: space,
        title: "Plan",
      }, { actor: ana });
      const say = (who: Actor, page: string, state: string) =>
        rt.call("document.presence", { document: doc, page, state }, { actor: who });
      const here = async () =>
        (await rt.call<Presence[]>("test.peek", {
          collection: "documentPresence",
          filter: { document: doc },
        }, { actor: ana })).map((p) => `${p.who} ${p.state}`).sort();

      await say(ana, "a1", "open");
      await say(bob, "b1", "editing");
      await say(bob, "b2", "open");
      assert.deepEqual(await here(), [
        "person:ana open",
        "person:bob editing",
        "person:bob open",
      ]);
      await say(bob, "b1", "open");
      await say(bob, "b2", "gone");
      assert.deepEqual(await here(), ["person:ana open", "person:bob open"]);
      // Presence records nothing: no events for it, and no Action calls on the record.
      const events: string[] = [];
      const off = rt.subscribe((item) => {
        const type = (item as { event?: { type?: string } }).event?.type;
        if (type) events.push(type);
      });
      await say(ana, "a1", "editing");
      await rt.idle();
      assert.equal(events.length, 0, `presence recorded ${events.join(", ")}`);
      // …where a save records its call and its writes.
      await rt.call("document.rename", { document: doc, title: "The plan" }, { actor: ana });
      await rt.idle();
      off();
      assert.ok(events.includes("document.updated") && events.includes("action.completed"));
      await assert.rejects(
        rt.call("document.presence", { document: doc, page: "../x", state: "open" }, {
          actor: ana,
        }),
      );
      // Deleting the document takes who had it open with it.
      await rt.call("document.delete", { document: doc }, { actor: ana });
      assert.deepEqual(await here(), []);
    } finally {
      await rt.close();
    }
  });

  test(`${name}: agents list, read, write, append to and edit documents, as versions`, async () => {
    const rt = await start(make);
    try {
      const { space: launch } = await rt.call<{ space: string }>("space.create", {
        name: "Launch",
      }, { actor: ana });
      await rt.call("person.set", { person: "bob", email: "bob@example.com" });
      const { space: secret } = await rt.call<{ space: string }>("space.create", {
        name: "Secret",
      }, { actor: bob });
      const { document: hidden } = await rt.call<Written>("document.create", {
        in: secret,
        title: "Bob's diary",
        text: "Dear diary",
      }, { actor: bob });
      let thread: string | undefined;
      const ask = async (tool: string, input: Record<string, unknown>) => {
        const sent = await rt.call<{ thread: string }>(
          "chat.send",
          {
            ...(thread ? { thread } : { in: launch }),
            text: `call ${tool} ${JSON.stringify(input)}`,
          },
          { actor: ana },
        );
        thread = sent.thread;
        await rt.idle();
        const said = outputs.splice(0);
        assert.equal(said.length, 1, `${tool} answered ${said.length} times`);
        return said[0];
      };

      assert.match(await ask("list_documents", {}), /No documents here yet/);
      const made = await ask("write_document", {
        title: "Launch plan",
        text: "# Launch plan\n\nGoal: ship",
      });
      assert.match(made, /^Made \[Launch plan\]\(\/document\/[\w-]+\) \(version 1, 3 lines\)\.$/);
      const id = made.match(/\/document\/([\w-]+)/)![1];
      assert.match(
        await ask("write_document", { title: "launch  PLAN", text: "Again" }),
        /There's a document called that here already/,
      );
      assert.match(
        await ask("append_document", { document: "launch plan", text: "## Risks\n\nNone yet" }),
        new RegExp(`^Saved \\[Launch plan\\]\\(/document/${id}\\) as version 2: \\+4 −0 lines\\.$`),
      );
      assert.match(
        await ask("edit_document", { document: id, old: "Goal: ship", new: "Goal: ship the beta" }),
        /as version 3: \+1 −1 lines/,
      );
      assert.match(
        await ask("edit_document", { document: id, old: "Goal: fly", new: "x" }),
        /isn't in \[Launch plan\]/,
      );
      assert.match(
        await ask("edit_document", { document: id, old: "e", new: "x" }),
        /occurs \d+ times in .*give more of what's around it/,
      );
      assert.match(
        await ask("edit_document", { document: "Nothing like it", old: "a", new: "b" }),
        /No document "Nothing like it" here\. These are: “Launch plan”/,
      );

      const read = await ask("read_document", { document: "Launch plan" });
      assert.match(read, /version 3 · .* · saved by Lead/);
      assert.match(read, /Goal: ship the beta\n\n## Risks\n\nNone yet$/);
      const old = await ask("read_document", { document: id, version: 1 });
      assert.match(old, /version 1 of 3, an old one/);
      assert.match(old, /# Launch plan\n\nGoal: ship$/);
      assert.match(await ask("read_document", { document: id, version: 7 }), /has no version 7/);
      // Another space's document, which Ana doesn't reach: not there for her agent.
      assert.match(await ask("read_document", { document: hidden }), /No document/);
      assert.match(
        await ask("edit_document", { document: hidden, old: "Dear", new: "Mine" }),
        /No document/,
      );

      const listed = await ask("list_documents", {});
      assert.match(listed, /^Documents here \(1\)/);
      assert.match(
        listed,
        new RegExp(`\\[Launch plan\\]\\(/document/${id}\\) · id ${id} · version 3`),
      );
      assert.doesNotMatch(listed, /diary/);

      // Each change is the agent's, for Ana.
      const history = await rt.query<Saved[]>("documentVersion.history", { document: id }, {
        actor: ana,
      });
      assert.deepEqual(history.map((v) => [v.version, v.kind, v.by, v.for]), [
        [3, "edit", "agent:lead", "person:ana"],
        [2, "append", "agent:lead", "person:ana"],
        [1, "create", "agent:lead", "person:ana"],
      ]);

      // A person who started before the agent's edits merges over them.
      const anas = await rt.call<Written>("document.save", {
        document: id,
        base: 1,
        text: "# Launch plan\n\nGoal: ship\n\nOwner: ana",
      }, { actor: ana });
      assert.equal(anas.merged, true);
      assert.equal(
        anas.text,
        "# Launch plan\n\nGoal: ship the beta\n\n## Risks\n\nNone yet\n\nOwner: ana",
      );

      // Replacing it whole, with a new title.
      assert.match(
        await ask("write_document", { document: id, title: "Plan", text: "All new" }),
        /^Saved \[Plan\]\(\/document\/[\w-]+\) as version 5: \+1 −\d+ lines\.$/,
      );
      assert.match(
        await ask("write_document", { document: id, text: "All new" }),
        /^No changes: \[Plan\]/,
      );
      const [doc] = await rt.call<Document[]>("test.peek", {
        collection: "document",
        filter: { _id: id },
      }, { actor: ana });
      assert.deepEqual([doc.title, doc.text, doc.savedBy, doc.savedFor], [
        "Plan",
        "All new",
        "agent:lead",
        "person:ana",
      ]);

      // Someone signed in with Google saves: they're said by name, never by that id.
      const dee: Actor = { kind: "person", id: "google:1139" };
      await rt.call("person.set", { person: dee.id, email: "dee@example.com", name: "Dee Ray" });
      const { invitation } = await rt.call<{ invitation: string }>("invitation.send", {
        space: launch,
        email: "dee@example.com",
        role: "editor",
      }, { actor: ana });
      await rt.call("invitation.accept", { invitation }, { actor: dee });
      await rt.idle();
      await rt.call<Written>("document.save", { document: id, base: 5, text: "Dee's" }, {
        actor: dee,
      });
      const theirs = await ask("read_document", { document: id });
      assert.match(theirs, /version 6 · .* · saved by Dee Ray/);
      assert.match(await ask("list_documents", {}), /saved by Dee Ray/);
      // Ana, from before Dee's save, on the same line: told who it was.
      const clash = await refused(
        rt.call("document.save", { document: id, base: 5, text: "Ana's" }, { actor: ana }),
      );
      assert.match(clash.message, /^Dee Ray saved version 6 since you started from version 5/);
      assert.doesNotMatch(theirs + clash.message, /google:1139/);
    } finally {
      await rt.close();
    }
  });

  test(`${name}: from outside, documents are read directly, and changed only by their Actions`, async () => {
    const rt = await start(make);
    try {
      const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
        actor: ana,
      });
      await join(rt, space, vera, "viewer");
      const { document: doc } = await rt.call<Written>("document.create", {
        in: space,
        title: "Plan",
        text: "The plan",
      }, { actor: ana });
      // Their browsers (each session's cookie), at the app's REST API.
      const as = async (person: string) => {
        const { session } = await rt.call<{ session: string }>("session.start", { person });
        return (method: string, path: string, body?: unknown) =>
          rt.fetch(
            new Request(`http://127.0.0.1/api/collections/${path}`, {
              method,
              headers: { cookie: `session=${session}`, "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
      };
      const [anas, veras] = [await as("ana"), await as("vera")];
      const read = await anas("GET", `document/${doc}`);
      assert.equal(read.status, 200);
      assert.equal((await read.json()).title, "Plan");
      const writes = [
        // A save with no version, a version by someone else, someone else's presence.
        await anas("PATCH", `document/${doc}`, { text: "Not a version", version: 9 }),
        await anas("POST", "documentVersion", {
          document: doc,
          in: space,
          version: 2,
          text: "Vera's words",
          by: "person:vera",
        }),
        await veras("POST", "documentPresence", { document: doc, in: space, who: "person:ana" }),
        await anas("DELETE", `document/${doc}`),
      ];
      for (const answer of writes) assert.equal(answer.status, 403, await answer.text());
      const history = await rt.query<{ version: number }[]>("documentVersion.history", {
        document: doc,
      }, { actor: ana });
      assert.deepEqual(history.map((v) => v.version), [1]);
    } finally {
      await rt.close();
    }
  });
}

test("people by their profiles' names; the id someone signed in with never shows", () => {
  const names = { "google:1139": "Dee Ray", "ana.lima@example.com": "Ana" };
  assert.equal(nameOf("person:google:1139", undefined, names), "Dee Ray");
  assert.equal(nameOf("person:google:1139"), "someone");
  assert.equal(nameOf("person:ana.lima@example.com", undefined, names), "Ana");
  assert.equal(nameOf("person:ana.lima@example.com"), "Ana Lima");
  assert.equal(nameOf("agent:north", (id) => id === "north" ? "North" : undefined), "North");
});
