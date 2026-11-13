/**
 * The public: whoever calls a public, stateless interface without being
 * anyone (`{ kind: "public" }`). A space lets them read it by having them as
 * a viewer, and that alone: not what it draws on, and nothing written, even
 * by a tool that says it only reads. A role above viewer can't be given to
 * them. A call with no actor at all is still no one.
 */
import { assertEquals } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
  people,
  publicCallers,
  type Runtime,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { access } from "../mod.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const anyone: Actor = { kind: "public", id: "" };
const code = (p: Promise<unknown>) =>
  p.then(() => "done", (e) => (e as { code?: string }).code ?? String(e));

type Note = { _id: string; in: string; text: string };
const text = { type: "string" } as const;
const opened = (actor: Actor) => people(actor) || publicCallers(actor);

const app = definePlugin({
  name: "public-test",
  requires: ["spaces"],
  collections: {
    note: defineCollection({
      schema: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
    }),
  },
  actions: {
    "note.add": defineAction({
      input: { type: "object", properties: { in: text, text }, required: ["in", "text"] },
      allow: opened,
      run: (ctx, input) => ctx.db.collection("note").insertOne(input),
    }),
    // A tool that says it only reads, and writes anyway.
    "note.sneak": defineAction({
      input: { type: "object", properties: { in: text }, required: ["in"] },
      allow: opened,
      run: (ctx, input) => ctx.db.collection("note").insertOne({ in: input.in, text: "sneaked" }),
    }),
    "note.list": defineAction({
      input: { type: "object" },
      allow: opened,
      run: async (ctx) =>
        (await ctx.db.collection<Note>("note").find({})).map((n) => n.text).sort(),
    }),
  },
  resources: { shared: { note: {} } },
});

async function setup(
  fn: (s: { rt: Runtime; docs: string; inner: string; team: string }) => Promise<void>,
) {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access, app] });
  try {
    const made = async (name: string) =>
      (await rt.call<{ space: string }>("space.create", { name }, { actor: ana })).space;
    const [docs, inner, team] = [await made("Docs"), await made("Inner"), await made("Team")];
    // Docs draws on Inner; only Docs is let to the public.
    await rt.call("member.set", {
      space: inner,
      member: { kind: "space", id: docs },
      role: "viewer",
    }, { actor: ana });
    for (const [where, said] of [[docs, "guide"], [inner, "draft"], [team, "plan"]]) {
      await rt.call("note.add", { in: where, text: said }, { actor: ana });
    }
    await fn({ rt, docs, inner, team });
  } finally {
    await rt.close();
  }
}

test("the public reads what's let to it, that alone, and writes nothing", async () => {
  await setup(async ({ rt, docs, team }) => {
    assertEquals(await rt.call("note.list", {}, { actor: anyone }), []);
    await rt.call("member.set", {
      space: docs,
      member: { kind: "public", id: "" },
      role: "viewer",
    }, { actor: ana });
    // Docs, not what it draws on, nor Team.
    assertEquals(await rt.call("note.list", {}, { actor: anyone }), ["guide"]);
    // Nothing it writes lands, even where it reads, even from a tool that says it only reads.
    assertEquals(await code(rt.call("note.sneak", { in: docs }, { actor: anyone })), "forbidden");
    assertEquals(
      await code(rt.call("note.add", { in: team, text: "x" }, { actor: anyone })),
      "forbidden",
    );
    assertEquals(await rt.call("note.list", {}, { actor: ana }), ["draft", "guide", "plan"]);
  });
});

test("the public is let in as a viewer only", async () => {
  await setup(async ({ rt, docs }) => {
    assertEquals(
      await code(rt.call("member.set", {
        space: docs,
        member: { kind: "public", id: "" },
        role: "editor",
      }, { actor: ana })),
      "invalid",
    );
  });
});
