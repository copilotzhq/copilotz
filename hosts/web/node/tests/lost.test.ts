/**
 * A process whose runtime lost its store to another owner goes, so the
 * platform starts a new one: `listen` serving `runtime.fetch`, and `serve`,
 * stop listening and exit with code 1 (run here as child processes, on one
 * SQLite file with the test). And a browser on that runtime isn't stranded:
 * its socket is moved off, it's told 503 while it tries again, and it comes
 * back to whoever serves the address next.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createRuntime,
  defineAction,
  definePlugin,
  type Runtime,
} from "../../../../runtime/mod.ts";
import { connect } from "../../../../runtime/client.ts";
import { memoryStore } from "../../../../stores/memory/mod.ts";
import { sqliteStore } from "../../../../stores/sql/sqlite/mod.ts";
import { spawn, tempFile, test, testWho, ticketFor } from "../../../../testing/mod.ts";
import { listen } from "../serve.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What `wait` gives once it's truthy, or a failure saying `what` after `ms`. */
async function until<T>(wait: () => Promise<T> | T, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await wait();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Not in time: ${what}`);
    await sleep(50);
  }
}

const fixture = fileURLToPath(new URL("./fixtures/lost.ts", import.meta.url));

for (const how of ["listen", "serve"]) {
  test(`${how}: a process whose runtime loses its store stops listening and exits with code 1`, async () => {
    const path = tempFile(".sqlite");
    const portFile = tempFile(".port");
    const child = spawn(fixture, { args: [how, path, portFile] });
    let exited: number | null | undefined;
    void child.exited.then((code) => exited = code);
    let other: Runtime | undefined;
    try {
      const port = await until(
        () => exited === undefined ? readFile(portFile, "utf8").catch(() => "") : "gone",
        "it serves",
      );
      assert(port !== "gone", `it exited first, with ${exited}`);
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      assertEquals([health.status, await health.text()], [200, "ok"]);
      // Another process opens the same store, as a second instance or a newer deploy would.
      other = await createRuntime({
        store: await sqliteStore({ path }),
        plugins: [],
        fenceCheck: false,
        warn: false,
      });
      assertEquals(await until(() => exited !== undefined && { exited }, "it exits"), {
        exited: 1,
      });
      await assertRejects(() => fetch(`http://127.0.0.1:${port}/health`));
    } finally {
      child.kill();
      await other?.close();
    }
  });
}

test("a browser on a runtime that lost its store comes back to whoever serves next", async () => {
  const ana = { kind: "person", id: "ana" };
  const store = memoryStore();
  const app = (name: string) =>
    definePlugin({
      name: "app",
      actions: {
        "app.who": defineAction({
          input: { type: "object" },
          allow: (actor) => actor.kind === "person",
          run: () => name,
        }),
      },
    });
  const first = await createRuntime({
    store,
    plugins: [app("first"), testWho],
    fenceCheck: 20,
    warn: false,
  });
  let current: Runtime = first;
  // One address for whichever runtime serves it, as a platform's router or a directory is: so
  // this listener stays up, and the lost runtime moves its browser off itself.
  const server = await listen((request) => current.fetch(request));
  const client = connect({
    transport: {
      type: "websocket",
      config: { url: `ws://127.0.0.1:${server.port}/oxian`, allowInsecureLoopback: true },
    },
    ticket: () => ticketFor(current, ana),
    plugins: [],
  });
  let second: Runtime | undefined;
  const error = console.error;
  console.error = () => {};
  try {
    await client.ready;
    assertEquals(await client.call("app.who", {}), "first");
    second = await createRuntime({
      store,
      plugins: [app("second"), testWho],
      fenceCheck: false,
      warn: false,
    });
    await first.lost;
    // Its socket was moved off; coming back here, it's told to wait (as is any request: Node's
    // fetch sends no upgrade, and the answer comes before anything looks at one).
    const refused = await fetch(`${server.url.origin}/oxian`);
    assertEquals([refused.status, refused.headers.get("retry-after")], [503, "5"]);
    await refused.body?.cancel();
    // The address is the new owner's now: the page comes back to it, as it is.
    current = second;
    assertEquals(
      await until(
        () => client.call<string>("app.who", {}).catch(() => undefined),
        "it's back",
        20_000,
      ),
      "second",
    );
  } finally {
    console.error = error;
    await client.close().catch(() => {});
    await server.shutdown();
    await first.close();
    await second?.close();
  }
});
