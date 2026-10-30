/**
 * A space's folder as a gzipped tar (`computer.archive`), streamed: its
 * paths relative to the folder asked for, dependencies and build caches left
 * out unless `all`; a path out of the space's folder answers its failure
 * instead; past `maxBytes`, it stops with an error.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { tempDir, test } from "../../../testing/mod.ts";
import { type Failed, type Scope, WORK } from "../computers/shared/workloads.ts";
import { type Setup, setup } from "./program-setup.ts";

const scope: Scope = { space: "s", folder: "alpha", who: "agent:a" };

/** The archive's bytes (or its failure, as JSON). */
async function archive(rt: Setup["rt"], input: Record<string, unknown>) {
  const job = await rt.workers.dispatch(
    "computer",
    "c1",
    WORK.archive,
    new TextEncoder().encode(JSON.stringify({ scope, ...input })),
  );
  return new Uint8Array(await new Response(job.output).arrayBuffer());
}

/** What an archive holds, as the system's tar lists it, its folders left out. */
function entries(bytes: Uint8Array): string[] {
  const file = join(tempDir(), "archive.tgz");
  writeFileSync(file, bytes);
  return execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter((line) => line && !line.endsWith("/") && line !== ".")
    .sort();
}

const failed = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Failed;

function write(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

// Windows' tar is bsdtar too, but its listing of what's left out differs: macOS and Linux here.
test({
  name: "a folder comes as a gzipped tar, its caches and dependencies left out unless all",
  ignore: process.platform === "win32",
  fn: () =>
    setup(async ({ rt, root }) => {
      write(join(root, "alpha"), {
        "README.md": "hi",
        "src/a.ts": "export {}",
        "src/build/out.js": "built",
        "node_modules/x/index.js": "dep",
        ".git/HEAD": "ref",
        "dist/app.js": "bundle",
        "app/.next/cache": "next",
        "py/__pycache__/m.pyc": "pyc",
      });
      const bytes = await archive(rt, {});
      assertEquals([bytes[0], bytes[1]], [0x1f, 0x8b]);
      assertEquals(entries(bytes), ["README.md", "src/a.ts"]);

      assertEquals(entries(await archive(rt, { all: true })), [
        ".git/HEAD",
        "README.md",
        "app/.next/cache",
        "dist/app.js",
        "node_modules/x/index.js",
        "py/__pycache__/m.pyc",
        "src/a.ts",
        "src/build/out.js",
      ]);
      // A folder of it: its paths relative to that folder.
      assertEquals(entries(await archive(rt, { path: "src" })), ["a.ts"]);
    }),
});

test("a path out of the space's folder, or not there, is refused", async () => {
  await setup(async ({ rt, root }) => {
    write(join(root, "alpha"), { "a.txt": "a" });
    write(join(root, "beta"), { "secret.txt": "s" });
    assertEquals(failed(await archive(rt, { path: "../beta" })).error.code, "invalid_path");
    assertEquals(failed(await archive(rt, { path: "/etc" })).error.code, "invalid_path");
    assertEquals(failed(await archive(rt, { path: "missing" })).error.code, "not_found");
    assertEquals(failed(await archive(rt, { path: "a.txt" })).error.code, "invalid");
    assertEquals(failed(await archive(rt, { maxBytes: 0 })).error.code, "invalid");
    if (process.platform !== "win32") {
      symlinkSync(tempDir(), join(root, "alpha", "out"));
      assertEquals(failed(await archive(rt, { path: "out" })).error.code, "invalid_path");
    }
  });
});

test({
  name: "past maxBytes, the archive stops with an error",
  ignore: process.platform === "win32",
  fn: () =>
    setup(async ({ rt, root }) => {
      // Random bytes don't compress: well past a few KiB.
      write(join(root, "alpha"), {
        "big.bin": Array.from({ length: 64 * 1024 }, () => Math.random().toString(36)).join(""),
      });
      const error = await assertRejects(() => archive(rt, { maxBytes: 4096 }));
      assert(String((error as Error).message).includes("too_large"), String(error));
    }),
});
