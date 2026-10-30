/**
 * What the computer program's tests share: a runtime with a minimal plugin
 * of the `computer` kind (it knows computer `c1` by its secret, and enrolls
 * a new one, `c2`, by a code), served over WebSocket as the web host serves
 * it, and a computer connected to it, all stopped when the test ends.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createRuntime,
  defineAction,
  defineCollection,
  definePlugin,
} from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { host, tempDir } from "../../../testing/mod.ts";
import {
  type Computer,
  type ComputerOptions,
  startComputer,
} from "../computers/program/computer.ts";
import { saveState } from "../computers/program/state.ts";
import { UPDATE } from "../computers/program/release.ts";
import { WORK } from "../computers/shared/workloads.ts";

export const SECRET = "s3cret";
export const CODE = "ABC-123";

const secret = { type: "object", properties: { secret: { type: "string" } } } as const;

/** A plugin of the `computer` kind, as little of one as tests need. */
export const computers = definePlugin({
  name: "computers-test",
  collections: {
    /** Computers it knows: their secrets. */
    known: defineCollection({ schema: secret }),
    /** Computers enrolled but not yet told their secret. */
    enrolling: defineCollection({ schema: secret }),
    /** What each computer presented to get in, in order. */
    presented: defineCollection({ schema: secret }),
  },
  workers: {
    computer: {
      admit: "test.admit",
      ready: "test.ready",
      workloads: [...Object.values(WORK), UPDATE],
    },
  },
  actions: {
    "test.admit": defineAction({
      input: secret,
      run: async (ctx, input) => {
        const given = input.secret ?? "";
        await ctx.db.collection("presented").insertOne({ secret: given });
        if (given === `c1.${SECRET}`) return { id: "c1" };
        if (given === `code:${CODE}`) {
          await ctx.db.collection("enrolling").replaceOne({ _id: "c2" }, { secret: randomUUID() }, {
            upsert: true,
          });
          return { id: "c2" };
        }
        const [id, rest] = given.split(".");
        const known = await ctx.db.collection("known").findOne({ _id: id });
        return known && known.secret === rest ? { id } : null;
      },
    }),
    // A computer just enrolled is told its id and secret.
    "test.ready": defineAction({
      input: { type: "object", properties: { id: { type: "string" } } },
      run: async (ctx, input) => {
        const id = input.id ?? "";
        const pending = await ctx.db.collection("enrolling").findOne({ _id: id });
        if (!pending?.secret) return null;
        await ctx.workers.call("computer", id, WORK.enrolled, { id, secret: pending.secret });
        await ctx.db.collection("known").replaceOne({ _id: id }, { secret: pending.secret }, {
          upsert: true,
        });
        await ctx.db.collection("enrolling").deleteOne({ _id: id });
        return null;
      },
    }),
    "test.presented": defineAction({
      input: { type: "object" },
      run: async (ctx) =>
        (await ctx.db.collection("presented").find({}).toArray()).map((doc) => doc.secret),
    }),
    // Work for a computer, as the plugin's Actions send it.
    "test.work": defineAction({
      input: {
        type: "object",
        properties: { id: { type: "string" }, workload: { type: "string" }, input: {} },
        required: ["workload"],
      },
      run: (ctx, input) =>
        ctx.workers.call("computer", input.id ?? "c1", input.workload, input.input),
    }),
  },
});

export type Setup = {
  rt: Awaited<ReturnType<typeof createRuntime>>;
  /** The app's URL, as a person gives it. */
  url: string;
  root: string;
  statePath: string;
  computer: Computer;
  /** Work for computer `c1` (or `id`), as the plugin sends it. */
  work<R = unknown>(workload: string, input: unknown, id?: string): Promise<R>;
  /** Starts another computer on the same app (stopped with the rest). */
  start(options?: Partial<ComputerOptions>): Promise<Computer>;
};

/** Runs `fn` with a runtime and computer `c1` connected to it; all stops after. */
export async function setup(
  fn: (setup: Setup) => Promise<void>,
  options: Partial<ComputerOptions> & { enrolled?: boolean } = {},
) {
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [computers],
    transports: [{ type: "websocket", config: { path: "/oxian" } }],
  });
  const listener = await host(rt.hypervisor);
  const url = `http://127.0.0.1:${new URL(String(listener.url)).port}`;
  const root = join(tempDir(), "Copilotz");
  const statePath = join(tempDir(), "config", "computer.json");
  const started: Computer[] = [];
  const start = async (more: Partial<ComputerOptions> = {}) => {
    const computer = await startComputer({
      url,
      root,
      statePath,
      chromium: null,
      log: () => {},
      ...options,
      ...more,
    });
    started.push(computer);
    return computer;
  };
  try {
    if (options.enrolled !== false) {
      await saveState({ connections: [{ url, root, id: "c1", secret: SECRET }] }, statePath);
    }
    const computer = await start();
    if (options.enrolled !== false) await computer.ready;
    await fn({
      rt,
      url,
      root,
      statePath,
      computer,
      start,
      work: (workload, input, id) =>
        rt.call("test.work", { workload, input, ...(id ? { id } : {}) }) as never,
    });
  } finally {
    await Promise.all(started.map((computer) => computer.stop()));
    await listener.shutdown();
    await rt.close();
  }
}

/** Until `check` holds (or `what` fails the test). */
export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
