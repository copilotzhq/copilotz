import { assertEquals, assertRejects } from "@std/assert";
import {
  createCopilotz,
  defineCollection,
  definePlugin,
  defineProcessor,
  PluginRegistry,
} from "../index.ts";

Deno.test("plugin resources compose core, declaration order, then top-level overrides", async () => {
  const first = definePlugin({
    manifest: {
      id: "first",
      version: "1.0.0",
      provides: { agents: ["support"] },
    },
    resources: {
      agents: [{ id: "support", name: "First", role: "first" }],
    },
  });
  const second = definePlugin({
    manifest: {
      id: "second",
      version: "1.0.0",
      provides: { agents: ["support"] },
      presets: { agent: ["agents.support"] },
    },
    resources: {
      agents: [{ id: "support", name: "Second", role: "second" }],
    },
  });
  const registry = await PluginRegistry.compose({
    plugins: [first, { ...second }],
    resources: {
      agents: [{ id: "support", name: "Explicit", role: "explicit" }],
    },
  });
  assertEquals(registry.require("agents", "support").name, "Explicit");
});

Deno.test("custom collection mutations emit events and execute independent processors", async () => {
  const note = defineCollection({
    name: "note",
    schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      required: ["text"],
      additionalProperties: true,
    } as const,
  });
  const handled: string[] = [];
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    collections: [note],
    processors: [
      defineProcessor({
        id: "note.one",
        on: ["note.created"],
        delivery: "durable",
        handle: (event) => {
          handled.push(`one:${event.type}`);
        },
      }),
      defineProcessor({
        id: "note.two",
        on: ["note.created"],
        delivery: "durable",
        handle: (event) => {
          handled.push(`two:${event.type}`);
        },
      }),
    ],
  });
  try {
    const scoped = copilotz.collections.withNamespace("tenant-a") as Record<
      string,
      { create(value: { text: string }): Promise<unknown> }
    >;
    await scoped.note.create({ text: "remember" });
    for (let index = 0; index < 20 && handled.length < 2; index++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertEquals(handled.toSorted(), ["one:note.created", "two:note.created"]);
    assertEquals(
      (await copilotz.events.list({ namespace: "tenant-a" })).map((event) =>
        event.type
      ),
      ["note.created"],
    );
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("durable matching refuses asynchronous filters before commit", async () => {
  const copilotz = await createCopilotz({
    database: { url: ":memory:" },
    maintenance: { periodic: false },
    processors: [defineProcessor({
      id: "invalid.filter",
      on: ["control.invalid"],
      delivery: "durable",
      filter: (() => Promise.resolve(true)) as unknown as () => boolean,
      handle: () => undefined,
    })],
  });
  try {
    const attachment = await copilotz.connect({
      thread: "filter-thread",
      participant: { externalId: "user", participantType: "human" },
    });
    await assertRejects(
      () => attachment.send({ type: "control.invalid", payload: {} }),
      TypeError,
      "must be synchronous",
    );
    assertEquals(
      (await copilotz.events.list({ threadId: attachment.thread.id }))
        .some((event) => event.type === "control.invalid"),
      false,
    );
    await attachment.close();
  } finally {
    await copilotz.shutdown();
  }
});
