/**
 * install.sh, as a person runs it on macOS or Linux: it downloads this
 * machine's binary from the app's release, checks its SHA-256 against the
 * manifest, puts it in ~/.copilotz/bin (and that on the PATH, once), then
 * runs `computer install <app> --code <code>`; a binary that doesn't check
 * is never installed. In a home of its own; the "binary" is a script that
 * notes how it was run.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { serve, tempDir, test } from "../../../testing/mod.ts";
import { binaryName, type Manifest } from "../computers/program/release.ts";

const SCRIPT = new URL("../computers/program/install/install.sh", import.meta.url).pathname;
const posix = process.platform !== "win32";
const file = binaryName({ os: platform(), arch: arch() });
const program = '#!/bin/sh\necho "$@" > "$HOME/ran"\n';
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A release served at `path`, its binary as `served` (what the manifest says unless given). */
async function release(
  path: string,
  fn: (url: string) => Promise<void>,
  served = program,
) {
  const manifest: Manifest = {
    version: "1.2.3",
    binaries: [
      { os: "win32", arch: "x64", file: "other.exe", size: 1, sha256: "b".repeat(64) },
      { os: platform(), arch: arch(), file, size: program.length, sha256: sha(program) },
    ],
  };
  const files: Record<string, string> = {
    [`${path}manifest.json`]: JSON.stringify(manifest, null, 2),
    [`${path}${file}`]: served,
  };
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

/** Runs install.sh in `home`; its exit code and what it said. */
const install = (home: string, args: string[]) =>
  new Promise<{ code: number; said: string }>((resolve) => {
    execFile(
      "/bin/sh",
      [SCRIPT, ...args],
      { env: { PATH: process.env.PATH, HOME: home, SHELL: "/bin/zsh" } },
      (error, out, err) => resolve({ code: error ? Number(error.code ?? 1) : 0, said: out + err }),
    );
  });

test({
  name: "install.sh installs this machine's binary, checked, on the PATH, and connects it",
  ignore: !posix,
  fn: () =>
    release("/computer/download/", async (url) => {
      const home = tempDir();
      const first = await install(home, [url, "--code", "K7Q-4MZ"]);
      assertEquals(first.code, 0, first.said);
      assertStringIncludes(first.said, "Copilotz computer 1.2.3");
      assertStringIncludes(first.said, "checked: its SHA-256 is the release's");
      const bin = join(home, ".copilotz", "bin", "computer");
      assertEquals(readFileSync(bin, "utf8"), program);
      assertEquals(readFileSync(join(home, "ran"), "utf8"), `install ${url} --code K7Q-4MZ\n`);
      assertStringIncludes(readFileSync(join(home, ".zshrc"), "utf8"), ".copilotz/bin:$PATH");
      // Again: it's there already, and the PATH line isn't added twice.
      const again = await install(home, [`${url}/some/page`, "--code", "K7Q-4MZ"]);
      assertEquals(again.code, 0, again.said);
      assertStringIncludes(again.said, "already installed");
      assertEquals(readFileSync(join(home, ".zshrc"), "utf8").split(".copilotz/bin").length, 2);
    }),
});

test({
  name: "install.sh never installs a binary whose SHA-256 isn't the release's",
  ignore: !posix,
  fn: () =>
    release("/computer/download/", async (url) => {
      const home = tempDir();
      const tampered = await install(home, [url, "--code", "K7Q-4MZ"]);
      assert(tampered.code !== 0);
      assertStringIncludes(tampered.said, "SHA-256 isn't the release's: not installed");
      assert(!existsSync(join(home, ".copilotz", "bin", "computer")), "nothing installed");
      assert(!existsSync(join(home, "ran")), "nothing ran");
    }, program + "# changed\n"),
});

test({
  name: "install.sh takes a release from elsewhere (--from), and says what's missing",
  ignore: !posix,
  fn: () =>
    release("/releases/v1/", async (url) => {
      const home = tempDir();
      const from = await install(home, [
        "https://app.example.com",
        "--code",
        "K7Q-4MZ",
        "--from",
        `${url}/releases/v1`,
      ]);
      assertEquals(from.code, 0, from.said);
      assertEquals(
        readFileSync(join(home, "ran"), "utf8"),
        "install https://app.example.com --code K7Q-4MZ\n",
      );
      const none = await install(tempDir(), [url, "--code", "K7Q-4MZ"]);
      assert(none.code !== 0);
      assertStringIncludes(none.said, "couldn't get");
      const usage = await install(tempDir(), [url]);
      assertStringIncludes(usage.said, "usage: install.sh <app-url> --code <CODE>");
    }),
});
