/**
 * Workers of a plugin's kind (a computer, say): a program that isn't plugin
 * code but does its work. It connects with `<kind>:<secret>`, which its
 * kind's Action admits; its kind hears it come and go; plugin code sends it
 * jobs by id, and reads its output as it comes. It asks the owner for
 * nothing: no storage, no work of its own.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createWorker } from "@oxian/oxian-js";
import { createRuntime, defineAction, defineCollection, definePlugin } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { decode, encode, lines, OP } from "../wire.ts";
import { test } from "../../testing/mod.ts";

const object = { type: "object" } as const;
/** Who its kind heard go, in order. */
const went: string[] = [];

const echoes = definePlugin({
  name: "echoes",
  collections: {
    echoer: defineCollection({
      schema: { type: "object", properties: { online: { type: "boolean" } } },
      queries: { state: (echoers) => echoers.findOne({ _id: "e1" }) },
    }),
  },
  workers: {
    echoer: {
      admit: "echoer.admit",
      ready: "echoer.ready",
      gone: "echoer.gone",
      workloads: ["echo", "count", "sneak"],
    },
  },
  actions: {
    "echoer.admit": defineAction({
      input: { type: "object", properties: { secret: { type: "string" } } },
      run: (_ctx, input) => input.secret === "s3cret" ? { id: "e1" } : null,
    }),
    "echoer.ready": defineAction({
      input: object,
      run: (ctx, input) =>
        ctx.db.collection("echoer").replaceOne({ _id: input.id }, { online: true }, {
          upsert: true,
        }).then(() => null),
    }),
    "echoer.gone": defineAction({
      input: object,
      run: (ctx, input) => {
        went.push(String(input.id));
        return ctx.db.collection("echoer").replaceOne({ _id: input.id }, { online: false }, {
          upsert: true,
        }).then(() => null);
      },
    }),
    "echo.ask": defineAction({
      input: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } },
      run: (ctx, input) =>
        ctx.workers.call("echoer", input.id ?? "e1", "echo", { text: input.text }),
    }),
    "echo.count": defineAction({
      input: object,
      run: async (ctx) => {
        const { output, done } = await ctx.workers.dispatch("echoer", "e1", "count", { to: 3 });
        const heard: unknown[] = [];
        for await (const line of lines(output)) heard.push(line);
        await done;
        return heard;
      },
    }),
    "echo.sneak": defineAction({
      input: object,
      run: (ctx) => ctx.workers.call("echoer", "e1", "sneak", {}),
    }),
  },
});

/** An echoer, as a computer would run: its work, nothing of plugin code. */
function echoer(topic: string, secret: string) {
  // One attempt per worker, as a computer has.
  const attempt = { attemptId: crypto.randomUUID(), epoch: Date.now() };
  return createWorker({
    id: `echoer-${crypto.randomUUID()}`,
    transport: { type: "in-process", config: { topic } },
    activate: ({ workerId }: { workerId: string }) => ({ identity: { workerId, ...attempt } }),
    register: () =>
      Promise.resolve({
        credential: { kind: "registration" as const, capability: `echoer:${secret}` },
        expiresAtMs: Date.now() + 60_000,
      }),
    capacity: 4,
    workloads: {
      echo: async ({ input }) => encode({ said: (await decode<{ text: string }>(input)).text }),
      count: async ({ input }) => {
        const { to } = await decode<{ to: number }>(input);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            for (let n = 1; n <= to; n++) controller.enqueue(encode({ n }));
            controller.close();
          },
        }).pipeThrough(new TransformStream({ transform: (c, out) => out.enqueue(c) }))
          // One JSON value per line.
          .pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform: (chunk, out) =>
                out.enqueue(new Uint8Array([...chunk, ...new TextEncoder().encode("\n")])),
            }),
          );
      },
      // A worker trying to reach storage: refused.
      sneak: async ({ callHost }) => {
        try {
          const call = await callHost({
            workload: OP,
            body: encode({ ops: [{ op: "find", collection: "echoer", filter: {} }] }),
          });
          await call.completed;
          return encode({ refused: false });
        } catch {
          return encode({ refused: true });
        }
      },
    },
  });
}

async function setup(
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>, topic: string) => Promise<void>,
) {
  const topic = `workers-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [echoes],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    await fn(rt, topic);
  } finally {
    await rt.close();
  }
}

/** Until `check` holds. */
async function until(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 200 && !await check(); i++) await new Promise((r) => setTimeout(r, 10));
  assert(await check(), what);
}

test("a worker of a plugin's kind is admitted, sent jobs, and heard coming and going", async () => {
  await setup(async (rt, topic) => {
    const online = async () => (await rt.query<{ online: boolean } | null>("echoer.state"))?.online;
    const worker = echoer(topic, "s3cret");
    await worker.ready;
    // Its kind heard it come.
    await until(async () => await online() === true, "ready was told");
    assertEquals(await rt.call("echo.ask", { text: "hi" }), { said: "hi" });
    assertEquals(await rt.call("echo.count", {}), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    // It asks the owner for nothing.
    assertEquals(await rt.call("echo.sneak", {}), { refused: true });
    // Another id, not connected: offline.
    const error = await assertRejects(() => rt.call("echo.ask", { id: "e2", text: "hi" }));
    assertEquals((error as { code?: string }).code, "offline");
    // It leaves: its kind hears it, and it's offline.
    await worker.stop();
    await until(async () => await online() === false, "gone was told");
    const gone = await assertRejects(() => rt.call("echo.ask", { text: "hi" }));
    assertEquals((gone as { code?: string }).code, "offline");
  });
});

test("a worker its kind doesn't know isn't let in", async () => {
  await setup(async (_rt, topic) => {
    const worker = echoer(topic, "wrong");
    try {
      await assertRejects(() => worker.ready);
    } finally {
      await worker.stop().catch(() => {});
    }
  });
});

test("a runtime closing tells its workers' kinds they went", async () => {
  const topic = `workers-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [echoes],
    transports: [{ type: "in-process", config: { topic } }],
  });
  const worker = echoer(topic, "s3cret");
  try {
    await worker.ready;
    await until(
      async () => (await rt.query<{ online: boolean } | null>("echoer.state"))?.online === true,
      "it came",
    );
    went.length = 0;
    await rt.close();
    assertEquals(went, ["e1"]);
  } finally {
    await worker.stop().catch(() => {});
  }
});
