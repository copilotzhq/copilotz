/**
 * Archiving a shared space: its managers put it away and bring it back; it
 * stays listed, marked; nobody else can, and a Personal space can't be.
 * And moving what's in a space: a memory goes where its person may write.
 */
import { assertEquals } from "@std/assert";
import { type Actor, createRuntime, defineAction, definePlugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { memory } from "../../agents/memory/mod.ts";
import { access } from "../mod.ts";
import { join } from "./join.ts";
import { test } from "../../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };
const refused = (promise: Promise<unknown>) =>
  promise.then(() => "done", (error) => (error as { code?: string }).code ?? "failed");

test("managers archive a shared space and bring it back; it stays listed, marked", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [...access] });
  try {
    const { space } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    await join(rt, space, bob, "editor", ana);
    const listed = async (actor: Actor) =>
      (await rt.query<{ _id: string; archived?: string }[]>("space.reached", {}, { actor }))
        .find((s) => s._id === space);
    assertEquals(
      await refused(rt.call("space.archive", { space, archived: true }, { actor: bob })),
      "forbidden",
    );
    await rt.call("space.archive", { space, archived: true }, { actor: ana });
    assertEquals(typeof (await listed(bob))?.archived, "string");
    await rt.call("space.archive", { space, archived: false }, { actor: ana });
    assertEquals((await listed(bob))?.archived, undefined);
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    assertEquals(
      await refused(rt.call("space.archive", { space: personal, archived: true }, { actor: ana })),
      "invalid",
    );
  } finally {
    await rt.close();
  }
});

test("a memory moves to a space its person may write in, and no other", async () => {
  const app = definePlugin({
    name: "app",
    resources: {
      shared: { thread: {}, message: {}, memory: {} },
      memory: { embedder: "hash/words" },
    },
    actions: {
      // A memory, as the person keeps it where they work.
      "test.remember": defineAction({
        input: { type: "object", properties: { in: { type: "string" } }, required: ["in"] },
        allow: () => true,
        run: async (ctx, input) =>
          (await ctx.db.collection("memory").insertOne({
            text: "Ana likes gardens",
            about: "person:ana",
            by: "ana",
            in: input.in,
            at: new Date().toISOString(),
          })).insertedId,
      }),
    },
  });
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, memory, ...access, app],
  });
  try {
    const { space: launch } = await rt.call<{ space: string }>("space.create", { name: "Launch" }, {
      actor: ana,
    });
    const { space: finance } = await rt.call<{ space: string }>("space.create", {
      name: "Finance",
    }, { actor: bob });
    await join(rt, finance, ana, "viewer", bob);
    const { space: personal } = await rt.call<{ space: string }>("space.personal", {}, {
      actor: ana,
    });
    const insertedId = await rt.call<string>("test.remember", { in: personal }, { actor: ana });
    // Into Launch, where she writes: moved.
    assertEquals(await rt.call("memory.move", { memory: insertedId, to: launch }, { actor: ana }), {
      moved: true,
    });
    // Into Finance, where she only reads: refused.
    assertEquals(
      await refused(rt.call("memory.move", { memory: insertedId, to: finance }, { actor: ana })),
      "forbidden",
    );
  } finally {
    await rt.close();
  }
});
