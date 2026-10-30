/**
 * The program updating itself: offered a newer version by the app, it fetches
 * the binary, checks its size, SHA-256 and that it says that version, swaps
 * it in, and stops to be started again as it. Anything that doesn't check is
 * never put in its place. (A "binary" here is a script that says a version.)
 */
import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { serve, tempDir, test } from "../../../testing/mod.ts";
import { checkOffer, updateProgram } from "../computers/program/update.ts";
import { VERSION } from "../computers/program/version.ts";
import { type Offer, UPDATE } from "../computers/program/release.ts";
import { setup } from "./program-setup.ts";

/** Scripts stand in for binaries where a script runs as one. */
const posix = process.platform !== "win32";
const binary = (version: string) => `#!/bin/sh\necho ${version}\n`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The program, installed in a folder of its own, at this version. */
function installed(): string {
  const path = join(tempDir(), "bin", "computer");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, binary(VERSION), { mode: 0o755 });
  return path;
}

/** Serves `files` by path; runs `fn` with the server's URL. */
async function served(files: Record<string, string>, fn: (url: string) => Promise<void>) {
  const server = await serve((request) => {
    const body = files[new URL(request.url).pathname];
    return new Response(body ?? "Not found", { status: body === undefined ? 404 : 200 });
  });
  try {
    await fn(server.url);
  } finally {
    await server.close();
  }
}

test({
  name: "an update that checks replaces the program; one that doesn't leaves it as it was",
  ignore: !posix,
  fn: async () => {
    const next = binary("9.0.0");
    const other = binary("8.0.0");
    const path = installed();
    await served({ "/good": next, "/other": other }, async (url) => {
      const offer = (over: Partial<Offer> = {}): Offer => ({
        version: "9.0.0",
        url: `${url}/good`,
        size: next.length,
        sha256: sha(next),
        ...over,
      });
      const refused = async (bad: Offer, why: string) => {
        const error = await assertRejects(() => updateProgram(path, bad));
        assertStringIncludes((error as Error).message, why);
        assertEquals(readFileSync(path, "utf8"), binary(VERSION), "it's as it was");
        assertEquals(readdirSync(dirname(path)), ["computer"], "nothing left beside it");
      };
      await refused(offer({ sha256: sha("something else") }), "SHA-256");
      await refused(offer({ size: next.length - 1 }), "larger than the app said");
      await refused(offer({ size: next.length + 1 }), `is ${next.length} bytes`);
      await refused(offer({ url: `${url}/missing` }), "404");
      await refused(
        offer({ url: `${url}/other`, size: other.length, sha256: sha(other) }),
        "says it's 8.0.0",
      );
      await updateProgram(path, offer());
      assertEquals(readFileSync(path, "utf8"), next);
      assert(statSync(path).mode & 0o100, "it can be run");
      assertEquals(readdirSync(dirname(path)), ["computer"]);
    });
  },
});

test("an offer is checked, its URL resolved against the app's (its socket's too)", () => {
  const offer = { version: "9.0.0", url: "/computer/download/x", size: 1, sha256: "a".repeat(64) };
  assertEquals(
    checkOffer(offer, "wss://app.example.com/oxian").url,
    "https://app.example.com/computer/download/x",
  );
  assertEquals(
    checkOffer({ ...offer, url: "https://releases.example.com/x" }, "http://127.0.0.1:1").url,
    "https://releases.example.com/x",
  );
  for (const bad of [{ ...offer, url: "file:///etc/passwd" }, { ...offer, sha256: "x" }, {}]) {
    let failed = false;
    try {
      checkOffer(bad, "https://app.example.com");
    } catch {
      failed = true;
    }
    assert(failed, JSON.stringify(bad));
  }
});

test({
  name: "offered a newer version, a computer updates itself and stops to start again as it",
  ignore: !posix,
  fn: async () => {
    const next = binary("99.0.0");
    const path = installed();
    await served({ "/computer": next }, async (url) => {
      await setup(async ({ computer, work }) => {
        const offer = { url: `${url}/computer`, size: next.length, sha256: sha(next) };
        // Not newer: nothing to do.
        assertEquals(await work(UPDATE, { ...offer, version: VERSION }), {
          updating: false,
        });
        assertEquals(await work(UPDATE, { ...offer, version: "99.0.0" }), {
          updating: true,
        });
        assertEquals(await computer.closed, "updated");
        assertEquals(readFileSync(path, "utf8"), next);
      }, { program: path });
    });
  },
});

test("run from source, a computer doesn't take updates", async () => {
  await setup(async ({ work }) => {
    const offer = {
      version: "99.0.0",
      url: "http://127.0.0.1:1/x",
      size: 1,
      sha256: "a".repeat(64),
    };
    await assertRejects(() => work(UPDATE, offer));
  }, { program: null });
});
