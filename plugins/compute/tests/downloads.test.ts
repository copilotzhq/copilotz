/**
 * An app's release of the computer program (`computerDownloads`): served
 * from its own origin at /computer/download/ (only the release's files, as
 * they are: binaries by their hash), or read from a URL; with its codes, the
 * connect flow gets where to download it; and a computer older than it is
 * offered the update, as its platform's binary.
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Actor, createRuntime, definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import models from "../../models/mod.ts";
import { chat } from "../../agents/chat/mod.ts";
import { access } from "../../access/mod.ts";
import { type Computer, computers } from "../mod.ts";
import { computerDownloads, releaseOf } from "../computers/resources/downloads.ts";
import { VERSION } from "../computers/program/version.ts";
import { type Manifest, UPDATE } from "../computers/program/release.ts";
import { createTickets } from "../../../hosts/web/tickets.ts";
import { webServer } from "../../../hosts/web/server.ts";
import { serve, tempDir, test } from "../../../testing/mod.ts";
import { fakeComputer } from "./fake-computer.ts";

const ana: Actor = { kind: "person", id: "ana" };
const BINARY = "pretend this is a program";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const manifest: Manifest = {
  version: "1.0.0-rc.2",
  binaries: [{
    os: "linux",
    arch: "x64",
    file: "copilotz-computer-linux-x64",
    size: BINARY.length,
    sha256: sha(BINARY),
  }],
};

/** A release folder, as the build makes one. */
function folder(): string {
  const dir = tempDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "install.sh"), "#!/bin/sh\necho install\n");
  writeFileSync(join(dir, "install.ps1"), "Write-Host install\n");
  writeFileSync(join(dir, "copilotz-computer-linux-x64"), BINARY);
  writeFileSync(join(dir, "secret.txt"), "not in the release");
  return dir;
}

async function setup(
  downloads: Plugin | undefined,
  fn: (rt: Awaited<ReturnType<typeof createRuntime>>, topic: string) => Promise<void>,
) {
  const topic = `downloads-test.${crypto.randomUUID()}`;
  const rt = await createRuntime({
    store: memoryStore(),
    plugins: [models, chat, ...access, computers, ...(downloads ? [downloads] : [])],
    transports: [{ type: "in-process", config: { topic } }],
  });
  try {
    await fn(rt, topic);
  } finally {
    await rt.close();
  }
}

test("a release folder is served at /computer/download/: its files only, binaries by their hash", async () => {
  await setup(await computerDownloads({ dir: folder() }), async (rt) => {
    const server = webServer({
      runtime: rt,
      tickets: createTickets(),
      code: { entry: "app.js", files: { "app.js": "" } },
      upgrade: () => new Response(null, { status: 299 }),
    });
    const get = (path: string, init?: RequestInit) =>
      server(new Request(`http://localhost/computer/download/${path}`, init));
    const listed = await get("manifest.json");
    assertEquals(listed.headers.get("content-type"), "application/json");
    assertEquals(await listed.json(), manifest);
    const script = await get("install.sh");
    assertEquals(script.headers.get("content-type"), "text/plain; charset=utf-8");
    assertEquals(await script.text(), "#!/bin/sh\necho install\n");
    const binary = await get("copilotz-computer-linux-x64");
    assertEquals(await binary.text(), BINARY);
    assertEquals(binary.headers.get("content-length"), String(BINARY.length));
    assertEquals(binary.headers.get("etag"), `"${sha(BINARY)}"`);
    assertStringIncludes(binary.headers.get("content-disposition") ?? "", "attachment");
    const same = await get("copilotz-computer-linux-x64", {
      headers: { "if-none-match": `"${sha(BINARY)}"` },
    });
    assertEquals(same.status, 304);
    const head = await get("copilotz-computer-linux-x64", { method: "HEAD" });
    assertEquals([head.status, await head.text()], [200, ""]);
    for (const path of ["secret.txt", "", "sub/secret.txt"]) {
      const missing = await get(path);
      assertEquals(missing.status, 404, path);
      await missing.body?.cancel();
    }
    // A way out of the folder isn't the release's (it's the app's page, or nothing).
    for (const path of ["../download/secret.txt", "%2e%2e/download/secret.txt"]) {
      assert(!(await (await get(path)).text()).includes("not in the release"), path);
    }
    // Only reading: a POST isn't the release's.
    const posted = await get("manifest.json", { method: "POST", body: "x" });
    assert(posted.status !== 200);
    await posted.body?.cancel();
  });
});

test("a release at a URL is read once, as the app starts; a folder that isn't one is refused", async () => {
  const server = await serve((request) =>
    new URL(request.url).pathname === "/v1/manifest.json"
      ? Response.json(manifest)
      : new Response("Not found", { status: 404 })
  );
  try {
    const plugin = await computerDownloads({ url: `${server.url}/v1` });
    assertEquals(plugin.resources?.downloads, { base: `${server.url}/v1/`, manifest });
    assertEquals(plugin.resources?.routes, undefined);
    await assertRejects(() => computerDownloads({ url: `${server.url}/v2/` }), Error, "404");
  } finally {
    await server.close();
  }
  const bad = tempDir();
  writeFileSync(join(bad, "manifest.json"), JSON.stringify({ version: "1", binaries: [{}] }));
  await assertRejects(
    () => computerDownloads({ dir: bad }),
    Error,
    "isn't a computer release's manifest",
  );
});

test("by default, the program is this Copilotz's release on GitHub: the program's version is the package's", () => {
  const root = new URL("../../../", import.meta.url);
  for (const file of ["deno.json", "package.json"]) {
    assertEquals(JSON.parse(readFileSync(new URL(file, root), "utf8")).version, VERSION, file);
  }
  assertEquals(
    releaseOf(),
    `https://github.com/copilotzhq/copilotz/releases/download/v${VERSION}/`,
  );
});

test("a code comes with where to download the program, when the app has a release", async () => {
  await setup(await computerDownloads({ dir: folder() }), async (rt) => {
    const made = await rt.call<{ downloads?: unknown }>("computer.code", {}, { actor: ana });
    assertEquals(made.downloads, { base: "/computer/download/", ...manifest });
  });
  await setup(undefined, async (rt) => {
    const made = await rt.call<{ downloads?: unknown }>("computer.code", {}, { actor: ana });
    assertEquals(made.downloads, undefined);
  });
});

test("on an org, a code says the folder its spaces go in: the org's name, plain; personal for one's own", async () => {
  const org = (name: string, kind: string) =>
    definePlugin({
      name: "org-here",
      resources: { org: { id: "o-1", name, kind, base: "/o/o-1" } },
    });
  const folderOf = async (plugin?: Plugin) => {
    let folder: unknown;
    await setup(plugin, async (rt) => {
      folder = (await rt.call<{ folder?: string }>("computer.code", {}, { actor: ana })).folder;
    });
    return folder;
  };
  assertEquals(await folderOf(org("Acme Studio, Inc.", "team")), "acme-studio-inc");
  assertEquals(await folderOf(org("Ana Souza", "personal")), "personal");
  assertEquals(await folderOf(org("!!!", "team")), undefined);
  assertEquals(await folderOf(), undefined);
});

test({
  name: "a computer older than the app's release is offered it; one as new isn't",
  // Once the plugin's computer workers serve updates (mod.ts: `workloads`).
  ignore: !computers.workers?.computer.workloads.includes(UPDATE),
  fn: () => offered(),
});

async function offered() {
  await setup(await computerDownloads({ dir: folder() }), async (rt, topic) => {
    const mine = () => rt.query<Computer[]>("computer.mine", {}, { actor: ana });
    const connect = async (version: string) => {
      const { code } = await rt.call<{ code: string }>("computer.code", {}, { actor: ana });
      const computer = fakeComputer(topic, `code:${code}`, {
        info: { os: "linux", arch: "x64", version },
        updates: true,
      });
      await computer.worker.ready;
      for (let i = 0; i < 300 && !(await mine()).some((c) => c.online); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      await rt.idle();
      await computer.worker.stop();
      for (let i = 0; i < 300 && (await mine()).some((c) => c.online); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      return computer.asked.filter((a) => a.work === UPDATE).map((a) => a.input);
    };
    assertEquals(await connect("1.0.0-rc.1"), [{
      version: "1.0.0-rc.2",
      url: "/computer/download/copilotz-computer-linux-x64",
      size: BINARY.length,
      sha256: sha(BINARY),
    }]);
    assertEquals(await connect("1.0.0-rc.2"), []);
    assertEquals(await connect("1.0.0"), []);
  });
}
