/**
 * A View's handlers write collections, as their viewer: the same write REST
 * and the socket make (a rule must speak for the collection's writes, the
 * schema checks it, it's recorded as theirs), wherever the View is observed:
 * in the owner (a terminal) or in a browser's client. A View never writes
 * while it renders, nor when it's rendered once.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  type Actor,
  createRuntime,
  defineCollection,
  definePlugin,
  type ViewContext,
} from "../mod.ts";
import { connect } from "../client.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test, testWho, ticketFor } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };

type Memo = { text: string; owner: string; n?: number };

/** What the `memos` View gives its page: the list, and handlers that write. */
type Memos = {
  texts: string[];
  add(text: string): Promise<{ insertedId: string }>;
  rename(id: string, text: string): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  wrong(): Promise<unknown>;
  locked(): Promise<unknown>;
};

const memos = definePlugin({
  name: "memos",
  collections: {
    memo: defineCollection({
      schema: {
        type: "object",
        properties: { text: { type: "string" }, owner: { type: "string" }, n: { type: "integer" } },
        required: ["text", "owner"],
        additionalProperties: false,
      },
    }),
    // No rule speaks for it: no outsider writes it.
    locked: defineCollection({ schema: { type: "object", properties: {} } }),
  },
  // A person reaches, and writes, their own memos.
  guard: (actor, { collection }) =>
    collection === "memo" && actor.kind === "person" ? { owner: actor.id } : undefined,
  views: {
    memos: (_: unknown, ctx: ViewContext): Memos => {
      const memo = ctx.db.collection<Memo>("memo");
      return {
        texts: (memo.find({}, { sort: { text: 1 } }).value ?? []).map((m) => m.text),
        // A browser's View doesn't know its person: the rule checks the memo is theirs.
        add: (text) => memo.insertOne({ text, owner: "ana" }),
        rename: (id, text) => memo.updateOne({ _id: id }, { text }),
        remove: (id) => memo.deleteOne({ _id: id }),
        wrong: () => memo.updateOne({ _id: "x" }, { $set: { n: "many" } }),
        locked: () => ctx.db.collection("locked").insertOne({}),
      };
    },
    // Writes while it renders: refused.
    eager: (_: unknown, ctx: ViewContext) => ({
      attempt: ctx.db.collection<Memo>("memo").insertOne({ text: "now", owner: "ana" }),
    }),
  },
});

const front = definePlugin({ name: "memos-web", views: memos.views });

async function until(check: () => boolean, what: string, ms = 2_000) {
  for (let i = 0; i < ms / 10 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(check(), what);
}

test("in the owner: a View's handlers write as its viewer, under the rules and the schema", async () => {
  const store = memoryStore();
  const rt = await createRuntime({ store, plugins: [memos, testWho] });
  try {
    const view = rt.observe<Memos>("memos", {}, { actor: ana });
    const ready = await view.ready;
    assert(ready.status === "ready");
    const page = () => (view.get() as { value: Memos }).value;
    const { insertedId } = await page().add("milk");
    await until(() => page().texts.length === 1, "the new memo shows");
    // Plain fields are set, as REST's PATCH sets them.
    await page().rename(insertedId, "oat milk");
    await until(() => page().texts[0] === "oat milk", "renamed");
    // On the record, as Ana's own.
    const made = (await store.events(0)).find((e) => e.type === "memo.created");
    assertEquals(made?.actor?.id, "ana");
    // The schema, and the rules, refuse what doesn't fit or isn't theirs to write.
    await page().add("eggs");
    const wrong = await assertRejects(() => page().wrong());
    // The caller's to fix: said to them, with its field.
    assertEquals(
      [(wrong as { code?: string }).code, (wrong as { public?: boolean }).public],
      ["invalid", true],
    );
    assertEquals((wrong as { detail?: unknown }).detail, { field: "n" });
    const locked = await assertRejects(() => page().locked());
    assertEquals((locked as { code?: string }).code, "forbidden");
    await page().remove(insertedId);
    await until(() => page().texts.join() === "eggs", "removed");
    view.close();
    // Never while it renders.
    const eager = rt.observe<{ attempt: Promise<unknown> }>("eager", {}, { actor: ana });
    const out = await eager.ready;
    assert(out.status === "ready");
    await assertRejects(() => out.value.attempt, Error, "never while it renders");
    eager.close();
  } finally {
    await rt.close();
  }
});

test("in a browser: a View's handlers write through the person's own connection", async () => {
  const topic = `view-writes.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [memos, testWho],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const client = connect({
    transport: { type: "in-process", config: { topic } },
    ticket: () => ticketFor(rt, ana),
    plugins: [front],
  });
  try {
    await client.ready;
    const view = client.observe<Memos>("memos", {});
    assert((await view.ready).status === "ready");
    const page = () => (view.get() as { value: Memos }).value;
    await page().add("bread");
    await until(() => page().texts.join() === "bread", "the new memo shows");
    const wrong = await assertRejects(() => page().wrong());
    assertEquals((wrong as { code?: string }).code, "invalid");
    assertEquals((wrong as { detail?: unknown }).detail, { field: "n" });
    view.close();
  } finally {
    await client.close();
    await rt.close();
  }
});
