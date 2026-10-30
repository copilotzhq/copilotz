/**
 * Enrolling a computer: it connects with a one-time code, is told its id and
 * secret, keeps them (readable only by its user), and connects as itself from
 * then on. A code the app doesn't take is said so; so is a computer it forgot.
 */
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { createRuntime } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { runtime, tempDir, test } from "../../../testing/mod.ts";
import { startComputer } from "../computers/program/computer.ts";
import {
  connectionOf,
  folderFor,
  loadState,
  sameApp,
  saveState,
  socketUrl,
  windowsSetting,
} from "../computers/program/state.ts";
import { VERSION } from "../computers/program/version.ts";
import { type Info, WORK } from "../computers/shared/workloads.ts";
import { CODE, computers, SECRET, setup, until } from "./program-setup.ts";

test("a computer enrolls with a code, keeps its id and secret, and connects as itself after", async () => {
  await setup(async ({ rt, computer, statePath, start, work, url, root }) => {
    await computer.ready;
    const mine = async () => connectionOf(await loadState(statePath), url);
    await until(async () => !!(await mine())?.secret, "it was told its secret");
    const state = await mine();
    assertEquals([state?.id, state?.url, state?.root], ["c2", url, root]);
    assertEquals((await loadState(statePath))?.name, "laptop");
    // Only its person reads it (Windows has no such modes: its folder is the person's).
    if (process.platform !== "win32") assertEquals(statSync(statePath).mode & 0o777, 0o600);
    assert(!readFileSync(statePath, "utf8").includes(CODE), "the code isn't kept");
    const info = await work<Info & { name: string }>(WORK.info, {}, "c2");
    assertEquals([info.version, info.browser, info.name], [VERSION, null, "laptop"]);
    const shell = process.platform === "win32" ? /pwsh(\.exe)?$|powershell\.exe$/i : /bash$/;
    assert(shell.test(info.shell) && info.root.endsWith("Copilotz"), info.shell);

    // It stops; run again, it connects as itself, not with its code.
    await computer.stop();
    const again = await start({ code: undefined });
    await again.ready;
    const presented = await rt.call<string[]>("test.presented", {});
    assertEquals(presented, [`code:${CODE}`, `c2.${state!.secret}`]);
    assertEquals((await work<Info>(WORK.info, {}, "c2")).version, VERSION);
  }, { enrolled: false, code: CODE, name: "laptop" });
});

test("enrolling keeps what connect kept: its name, and whether windows may be shown", async () => {
  await setup(async ({ start, url, root }) => {
    const statePath = join(tempDir(), "computer.json");
    // As `connect --name desk --windows never` keeps it, before the app answers.
    await saveState({ connections: [{ url, root }], name: "desk", windows: "never" }, statePath);
    await (await start({ code: CODE, statePath })).ready;
    const told = async () => !!connectionOf(await loadState(statePath), url)?.secret;
    await until(told, "it was told its secret");
    const state = await loadState(statePath);
    assertEquals(
      [connectionOf(state, url)?.id, state?.name, state?.windows],
      ["c2", "desk", "never"],
    );
  }, { enrolled: false, code: "NOT-THIS-ONE" });
});

test("--windows is allow or never", () => {
  assertEquals(windowsSetting("never", "--windows"), "never");
  assertEquals(windowsSetting("allow", "--windows"), "allow");
  assertEquals(windowsSetting(undefined, "--windows"), undefined);
  const error = assertThrows(() => windowsSetting("sometimes", "COPILOTZ_BROWSER_WINDOWS"));
  assert(
    String((error as Error).message).includes('COPILOTZ_BROWSER_WINDOWS is "allow" or "never"'),
  );
});

test("a code the app doesn't take, or a computer it doesn't know, is turned away", async () => {
  await setup(async ({ start, url }) => {
    const wrong = await start({ code: "WRONG", statePath: join(tempDir(), "computer.json") });
    const error = await assertRejects(() => wrong.closed);
    assertEquals((error as { code?: string }).code, "refused");
    assert(String((error as Error).message).includes("code"));
    await assertRejects(() => wrong.ready);

    const forgotten = join(tempDir(), "computer.json");
    await saveState(
      { connections: [{ url, root: tempDir(), id: "c9", secret: "old" }] },
      forgotten,
    );
    const unknown = await start({ statePath: forgotten });
    const gone = await assertRejects(() => unknown.closed);
    assertEquals((gone as { code?: string }).code, "refused");
    assert(String((gone as Error).message).includes("doesn't know this computer"));
  }, { enrolled: false, code: "ALSO-WRONG" });
});

/** Serves `hypervisor` on `port` (0: any), as testing's `host` does. */
async function serveOn(hypervisor: unknown, port: number) {
  const adapter = runtime === "deno"
    ? "@oxian/oxian-js/adapters/deno"
    : "@oxian/oxian-js/adapters/node";
  const { serve } = await import(adapter);
  return await serve({ hypervisor, hostname: "127.0.0.1", port }) as {
    url: string | URL;
    shutdown(): Promise<void>;
  };
}

test("when the app restarts, the computer connects again as itself", async () => {
  const transports = [{ type: "websocket" as const, config: { path: "/oxian" } }];
  const first = await createRuntime({ store: memoryStore(), plugins: [computers], transports });
  let listener = await serveOn(first.hypervisor, 0);
  const port = Number(new URL(String(listener.url)).port);
  const statePath = join(tempDir(), "computer.json");
  const url = `http://127.0.0.1:${port}`;
  await saveState({ connections: [{ url, root: tempDir(), id: "c1", secret: SECRET }] }, statePath);
  const computer = await startComputer({
    url,
    root: tempDir(),
    statePath,
    chromium: null,
    log: () => {},
  });
  let second: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    await computer.ready;
    await listener.shutdown();
    await first.close();
    // The new app knows nothing of the old one's sessions.
    second = await createRuntime({ store: memoryStore(), plugins: [computers], transports });
    listener = await serveOn(second.hypervisor, port);
    const app = second;
    await until(
      async () => {
        const info = await app.call("test.work", { workload: WORK.info, input: {} }).catch(() =>
          null
        );
        return (info as Info | null)?.version === VERSION;
      },
      "it's back",
      20_000,
    );
    assertEquals(await app.call("test.presented", {}), [`c1.${SECRET}`]);
  } finally {
    await computer.stop();
    await listener.shutdown().catch(() => {});
    await first.close().catch(() => {});
    await second?.close();
  }
});

test("an app's URL becomes its socket; a socket stays as it is", () => {
  assertEquals(socketUrl("http://127.0.0.1:8790"), "ws://127.0.0.1:8790/oxian");
  assertEquals(socketUrl("https://app.example.com/some/page"), "wss://app.example.com/oxian");
  // An org of a host serving many is reached under its address.
  assertEquals(socketUrl("https://app.example.com/o/acme"), "wss://app.example.com/o/acme/oxian");
  assertEquals(socketUrl("https://app.example.com/o/acme/"), "wss://app.example.com/o/acme/oxian");
  assertEquals(
    socketUrl("ws://127.0.0.1:8787/core/executors"),
    "ws://127.0.0.1:8787/core/executors",
  );
  assertEquals(socketUrl("wss://app.example.com/oxian"), "wss://app.example.com/oxian");
});

test("one machine, two apps: a computer of each, its spaces apart, in one state", async () => {
  const transports = [{ type: "websocket" as const, config: { path: "/oxian" } }];
  const apps = await Promise.all([0, 1].map(async () => {
    const rt = await createRuntime({ store: memoryStore(), plugins: [computers], transports });
    const listener = await serveOn(rt.hypervisor, 0);
    return { rt, listener, url: `http://127.0.0.1:${new URL(String(listener.url)).port}` };
  }));
  const statePath = join(tempDir(), "computer.json");
  const base = tempDir();
  const [first, second] = [join(base, "first"), join(base, "second")];
  // Connected to the first already, in a folder of its own; the second, with a code.
  await saveState({
    connections: [{ url: apps[0].url, root: first, id: "c1", secret: SECRET }],
    name: "laptop",
  }, statePath);
  const options = { statePath, chromium: null, log: () => {} };
  const started = [
    await startComputer({ ...options, url: apps[0].url, root: first }),
    await startComputer({ ...options, url: apps[1].url, root: second, code: CODE }),
  ];
  try {
    await Promise.all(started.map((computer) => computer.ready));
    const told = async () => !!connectionOf(await loadState(statePath), apps[1].url)?.secret;
    await until(told, "the second app told it its secret");
    const state = await loadState(statePath);
    assertEquals(state?.connections.map((c) => [c.url, c.root, c.id]), [
      [apps[0].url, first, "c1"],
      [apps[1].url, second, "c2"],
    ]);
    assertEquals(state?.name, "laptop");
    // Each app's work, in its own folder.
    const scope = { space: "s", folder: "alpha", who: "agent:a" };
    for (const [i, id] of [[0, "c1"], [1, "c2"]] as const) {
      await apps[i].rt.call("test.work", {
        workload: WORK.filesWrite,
        input: { scope, path: "a.txt", content: `app ${i}` },
        id,
      });
    }
    assertEquals(readFileSync(join(first, "alpha", "a.txt"), "utf8"), "app 0");
    assertEquals(readFileSync(join(second, "alpha", "a.txt"), "utf8"), "app 1");
  } finally {
    await Promise.all(started.map((computer) => computer.stop()));
    for (const app of apps) {
      await app.listener.shutdown();
      await app.rt.close();
    }
  }
});

test("a state kept before a machine served many apps is its one connection, its folder as it was", async () => {
  const path = join(tempDir(), "computer.json");
  writeFileSync(
    path,
    JSON.stringify({
      url: "https://app.example.com/o/acme",
      root: "/x/Copilotz",
      id: "c1",
      secret: "s",
      name: "laptop",
      windows: "never",
    }),
  );
  assertEquals(await loadState(path), {
    connections: [{
      url: "https://app.example.com/o/acme",
      root: "/x/Copilotz",
      id: "c1",
      secret: "s",
    }],
    name: "laptop",
    windows: "never",
  });
});

test("an app's folder: as the app names it, else its org, else its host, numbered when taken; the same app, by its socket", () => {
  assertEquals(folderFor("https://app.example.com/o/o-1a2b", [], "Acme Studio"), "acme-studio");
  assertEquals(folderFor("https://app.example.com/o/o-1a2b", ["acme"], "acme"), "acme-2");
  assertEquals(folderFor("https://app.example.com/o/o-1a2b", [], "../.."), "o-1a2b");
  assertEquals(folderFor("https://app.example.com/o/acme"), "acme");
  assertEquals(folderFor("https://app.example.com"), "app.example.com");
  assertEquals(folderFor("https://app.example.com/o/acme", ["acme"]), "acme-2");
  assert(sameApp("https://app.example.com/o/acme", "https://app.example.com/o/acme/chat"));
  assert(!sameApp("https://app.example.com/o/acme", "https://app.example.com/o/beta"));
});
