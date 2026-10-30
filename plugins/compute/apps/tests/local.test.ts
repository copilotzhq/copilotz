/**
 * The local app host (development and tests): it extracts a folder's
 * archive, nothing outside it, and runs its command on a free port; or,
 * given a target, runs nothing.
 */
import { assert, assertEquals } from "@std/assert";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { runtime, tempDir, test } from "../../../../testing/mod.ts";
import { localHost } from "../adapters/local.ts";
import { streamOf, tgz } from "./tgz.ts";

// deno-lint-ignore no-explicit-any
const g = globalThis as any;
/** This runtime, running a script (Node's `http` either way). */
const exec = runtime === "deno" ? `"${g.Deno.execPath()}" run -A` : `"${process.execPath}"`;

const SERVER = `import { createServer } from "node:http";
createServer((_, res) => res.end("hello from " + process.env.GREETING)).listen(Number(process.env.PORT), "127.0.0.1");
`;

test("the local host extracts the folder, runs its command on PORT, and removes it", async () => {
  const dir = tempDir();
  const host = localHost({ dir });
  try {
    const long = `deep/${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const archive = await tgz({
      "server.mjs": SERVER,
      "bin/run.sh": "#!/bin/sh\necho hi\n",
      [long]: "far down",
      "../escape.txt": "outside",
    });
    const { image } = await host.build({
      app: "site",
      archive: streamOf(archive),
      command: `${exec} server.mjs`,
      port: 3000,
    });
    assert(image.startsWith(dir), "built in its folder");
    assertEquals(readFileSync(join(image, long), "utf8"), "far down");
    assert(statSync(join(image, "bin/run.sh")).mode & 0o100, "still executable");
    assert(!existsSync(join(image, "..", "escape.txt")), "nothing outside it");

    const deployed = await host.deploy({
      app: "site",
      image,
      port: 3000,
      env: { GREETING: "the app" },
    });
    assertEquals(deployed.service, "local/site");
    const response = await fetch(deployed.target);
    assertEquals(await response.text(), "hello from the app");

    await host.remove("site");
    assert(!existsSync(image), "its folder went");
    const gone = await fetch(deployed.target).then(() => false, () => true);
    assert(gone, "it stopped");
  } finally {
    await host.close();
  }
});

test("the local host, given a target, runs nothing and answers it", async () => {
  const host = localHost({ dir: tempDir(), target: "http://127.0.0.1:9" });
  try {
    const { image } = await host.build({
      app: "x",
      archive: streamOf(await tgz({ "a.txt": "a" })),
      port: 3000,
    });
    assertEquals(await host.deploy({ app: "x", image, port: 3000 }), {
      service: "local/x",
      target: "http://127.0.0.1:9",
      revision: "x-00001",
    });
  } finally {
    await host.close();
  }
});
