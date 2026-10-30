/**
 * A job's authority is the owner's to give: an executor's op in a job acts
 * as whom the job works for. Claiming someone else, or nobody (the system),
 * is refused; trusted code that chose to act for another (`ctx.as()`) says
 * whose job it was, and only then passes. A system job's code may act for
 * anyone. The executor here is a raw one, sending what it likes.
 */
import { assertEquals } from "@std/assert";
import { createWorker } from "@oxian/oxian-js";
import { type Actor, createRuntime, defineAction, definePlugin } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { decode, encode, type Job, OP, type OpReply, output, RUN } from "../wire.ts";
import { test } from "../../testing/mod.ts";

const ana: Actor = { kind: "person", id: "ana" };
const bob: Actor = { kind: "person", id: "bob" };

const app = definePlugin({
  name: "app",
  collections: { note: { schema: { type: "object" } } },
  actions: {
    // Its input names the actor the raw executor claims for its op.
    "note.read": defineAction({
      input: { type: "object", properties: { as: {} } },
      allow: () => true,
      run: () => null,
    }),
  },
});

test("an executor acts only as its job's actor, or says it acts for them", async () => {
  const topic = `authority-${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [app],
    executors: 0,
    transports: [{ type: "in-process", config: { topic } }],
  });
  // An executor in this process, as the owner's own are: no key to show.
  const worker = createWorker({
    id: "raw",
    transport: { type: "in-process", config: { topic } },
    capacity: 8,
    workloads: {
      [RUN]: async ({ input, callHost }) => {
        const job = await decode<Job>(input);
        const claimed = (job as { input?: { as?: Actor | null } }).input?.as;
        const call = await callHost({
          workload: OP,
          body: encode({
            ops: [{ op: "find", collection: "note", filter: {}, options: {} }],
            ...(claimed ? { actor: claimed } : {}),
          }),
        });
        const answer = await decode<OpReply>(call.output);
        await call.completed;
        const out = output();
        out.end({ result: "error" in answer ? answer.error.code ?? answer.error.message : "ok" });
        return out.readable;
      },
    },
  });
  await worker.ready;
  try {
    const as = (claimed: Actor | null, actor?: Actor) =>
      rt.call("note.read", { as: claimed }, actor ? { actor } : {});
    assertEquals(await as(ana, ana), "ok");
    assertEquals(await as(bob, ana), "forbidden");
    // Nobody named, in someone's job: that would be the system, unsaid.
    assertEquals(await as(null, ana), "forbidden");
    // Trusted code acting for another says whose job it was.
    assertEquals(await as({ ...bob, via: ana }, ana), "ok");
    assertEquals(await as({ kind: "system", id: "system", via: ana }, ana), "ok");
    assertEquals(await as({ ...bob, via: { kind: "person", id: "eve" } }, ana), "forbidden");
    // A job that is itself someone acting for another (a timer set through ctx.as()):
    // acting on from it keeps the whole chain.
    const bobForAna = { ...bob, via: ana };
    assertEquals(await as({ kind: "system", id: "system", via: bobForAna }, bobForAna), "ok");
    assertEquals(await as({ kind: "system", id: "system", via: bob }, bobForAna), "forbidden");
    // A system job's code may act for anyone.
    assertEquals(await as(bob), "ok");
    assertEquals(await as(null), "ok");
  } finally {
    await worker.stop();
    await rt.close();
  }
});
