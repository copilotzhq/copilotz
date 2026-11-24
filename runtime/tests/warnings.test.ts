/**
 * What looks wrong is said at startup, though the app runs: a collection whose
 * schema names no fields, and one another plugin's `shared` rule alone opens.
 * An unknown Action, collection or query is refused naming the closest known
 * one.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, defineCollection, definePlugin } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test, TEST_ACTOR, testWho } from "../../testing/mod.ts";

const tasks = definePlugin({
  name: "tasks",
  collections: {
    task: defineCollection({
      schema: { type: "object", properties: { title: { type: "string" } } },
      queries: { open: (all) => all.find({}).toArray() },
    }),
    loose: defineCollection({ schema: { type: "object" } }),
  },
  actions: {
    "task.add": defineAction({
      input: { type: "object" },
      run: (ctx) => ctx.db.collection("taks").insertOne({ title: "x" }),
    }),
  },
});
// Another plugin opens tasks to outsiders, where the tasks plugin says nothing of who may.
const opener = definePlugin({ name: "opener", resources: { shared: { task: {} } } });

test("startup says what looks wrong, once, and still starts", async () => {
  const told: string[] = [];
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [tasks, opener],
    warn: (message) => told.push(message),
  });
  try {
    assertEquals(told.length, 2, told.join("\n"));
    assert(told.some((m) => m.includes(`"loose" (tasks) has a schema that names no fields`)));
    assert(told.some((m) => m.includes(`"task" (tasks) is opened to outsiders by opener's`)));
  } finally {
    await rt.close();
  }
  // `false` tells nothing.
  const quiet = await createRuntime({ store: memoryStore(), plugins: [tasks], warn: false });
  await quiet.close();
});

test("an unknown name is refused with the closest known one", async () => {
  const rt = await createRuntime({ store: memoryStore(), plugins: [tasks], warn: false });
  try {
    await assertRejects(() => rt.call("task.ad", {}), Error, `did you mean "task.add"?`);
    await assertRejects(() => rt.call("task.add", {}), Error, `did you mean "task"?`);
    await assertRejects(() => rt.query("task.opne", {}), Error, `did you mean "task.open"?`);
    // Nothing near: no guess.
    const far = await assertRejects(() => rt.call("billing.charge", {}));
    assertEquals((far as Error).message, `Unknown action "billing.charge"`);
  } finally {
    await rt.close();
  }
});

test("an outsider let in by another plugin's guard alone is said, once a collection", async () => {
  const told: string[] = [];
  const docs = definePlugin({
    name: "docs",
    collections: {
      doc: defineCollection({ schema: { type: "object", properties: { t: { type: "string" } } } }),
    },
  });
  const opener = definePlugin({
    name: "opener",
    guard: (actor, { collection }) =>
      collection === "doc" && actor.kind === "person" ? true : undefined,
  });
  const read = (rt: Awaited<ReturnType<typeof createRuntime>>) =>
    rt.fetch(
      new Request("http://localhost/api/collections/doc", {
        headers: { [TEST_ACTOR]: JSON.stringify({ kind: "person", id: "ana" }) },
      }),
    );
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [docs, opener, testWho],
    warn: (message) => told.push(message),
  });
  try {
    assertEquals((await read(rt)).status, 200);
    assertEquals((await read(rt)).status, 200);
    assertEquals(told.filter((m) => m.includes("opener's guard alone")).length, 1, told.join("\n"));
  } finally {
    await rt.close();
  }
  // The collection's own plugin ruling it: nothing to say.
  const own = definePlugin({ ...docs, guard: opener.guard });
  const quiet: string[] = [];
  const rt2 = await createRuntime({
    store: memoryStore(),
    plugins: [own, testWho],
    warn: (message) => quiet.push(message),
  });
  try {
    assertEquals((await read(rt2)).status, 200);
    assertEquals(quiet.filter((m) => m.includes("guard alone")), []);
  } finally {
    await rt2.close();
  }
});
