/**
 * Runtimes by id (`runtimes(open, { idleMs })`): each opened on its first
 * use and the same one after; none when `open` says so, and a failed
 * opening tried again; closed once idle (no browsers, nothing pending), and
 * open again on its next use; closed on demand, never two of one id at
 * once; and all of them closed for good.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime, defineAction, definePlugin, type Runtime, runtimes } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { test } from "../../testing/mod.ts";

/** A runtime that says which it is, and whose `probe.wait` events wait until they're let go. */
async function named(id: string, gate?: Promise<void>): Promise<Runtime> {
  return await createRuntime({
    store: memoryStore(),
    plugins: [
      definePlugin({
        name: "probe",
        actions: { "probe.id": defineAction({ input: { type: "object" }, run: () => id }) },
        events: { "probe.wait": { schema: { type: "object" } } },
        processors: { "probe.waits": { on: "probe.wait", run: async () => await gate } },
      }),
    ],
  });
}

const until = async (done: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("Not in time");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("runtimes: opened on first use, the same one after; none when open says so", async () => {
  const opened: string[] = [];
  const pool = runtimes(async (id) => {
    opened.push(id);
    if (id === "nobody") return undefined;
    if (id === "broken" && opened.filter((o) => o === id).length === 1) {
      throw new Error("Not yet");
    }
    return await named(id);
  });
  try {
    const [a, again] = await Promise.all([pool.get("a"), pool.get("a")]);
    assert(a && a === again);
    assertEquals(await a.call("probe.id", {}), "a");
    assertEquals(pool.peek("a"), a);
    assertEquals(pool.peek("b"), undefined);
    assertEquals(await pool.get("nobody"), undefined);
    // A failed opening is tried again on the next use.
    await assertRejects(() => pool.get("broken"), Error, "Not yet");
    assertEquals(await (await pool.get("broken"))!.call("probe.id", {}), "broken");
    assertEquals(opened, ["a", "nobody", "broken", "broken"]);
    assertEquals(pool.entries().map(([id]) => id).sort(), ["a", "broken"]);
  } finally {
    await pool.close();
  }
  await assertRejects(() => pool.get("a"), Error, "closed");
  assertEquals(pool.entries(), []);
});

test("runtimes: one idle closes (no browsers, nothing pending), and opens again when used", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const closed: string[] = [];
  const pool = runtimes(async (id) => {
    const runtime = await named(id, gate);
    return {
      ...runtime,
      close: async (options) => {
        closed.push(id);
        await runtime.close(options);
      },
    } satisfies Runtime;
  }, { idleMs: 30 });
  try {
    const quiet = await pool.get("quiet");
    const busy = await pool.get("busy");
    // Something pending (a delivery) keeps one open past its idle time.
    await busy!.emit("probe.wait", {});
    await until(() => closed.includes("quiet"));
    assertEquals(pool.peek("quiet"), undefined);
    assert(pool.peek("busy"));
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(closed, ["quiet"]);
    release();
    await until(() => closed.includes("busy"));
    // Used again: open again, a new one.
    const back = await pool.get("quiet");
    assert(back && back !== quiet);
    assertEquals(await back.call("probe.id", {}), "quiet");
  } finally {
    await pool.close();
  }
});

test("runtimes: closed on demand, never two of one id at once", async () => {
  const running = new Map<string, number>();
  let most = 0;
  const pool = runtimes(async (id) => {
    const runtime = await named(id);
    running.set(id, (running.get(id) ?? 0) + 1);
    most = Math.max(most, running.get(id)!);
    return {
      ...runtime,
      close: async (options) => {
        // Slow to close, as a writer finishing its last commit is.
        await new Promise((r) => setTimeout(r, 30));
        await runtime.close(options);
        running.set(id, running.get(id)! - 1);
      },
    } satisfies Runtime;
  });
  try {
    const first = await pool.get("acme");
    const closing = pool.close("acme");
    assertEquals(pool.peek("acme"), undefined);
    // Asked again while it closes: a new one, once the old one has closed.
    const second = await pool.get("acme");
    await closing;
    assert(second && second !== first);
    assertEquals(most, 1);
    assertEquals(await second.call("probe.id", {}), "acme");
  } finally {
    await pool.close();
  }
  assertEquals(running.get("acme"), 0);
});
