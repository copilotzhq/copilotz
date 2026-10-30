/**
 * The computer program's release, built from its sources into
 * `dist/computer/<version>/` (the version is `program/version.ts`'s): a
 * single executable per platform, compiled by Bun, its install scripts, and
 * `manifest.json`, which says the version, each binary's file, size and
 * SHA-256, and what the program is (`source`; see `program/release.ts`). An
 * app serves that folder as it is, at `/computer/download/` (or from a
 * release or a bucket: the computers plugin's `computerDownloads`), and its
 * computers update themselves to it.
 *
 * `source` is a SHA-256 of what makes the program: its code as Bun bundles it
 * (its version left out), its install scripts, the Bun that builds it and the
 * targets. Given a release (`--reuse <url>`) whose `source` is this one, it
 * takes that release's binaries and manifest (checked by their SHA-256)
 * instead of building: the same program keeps its version, so computers
 * don't update to what they have. The publish workflow does so with the last
 * release.
 *
 * Runs on Node 24 (and Deno, Bun); Bun comes from npm. macOS binaries are
 * signed ad hoc (`codesign -s -`), as macOS needs (Bun's own signature
 * doesn't hold once the program is in it), so they're built on a Mac:
 * elsewhere, name the other platforms.
 *
 *   node scripts/computer/build.ts                  # every platform
 *   node scripts/computer/build.ts darwin-arm64     # some (os-arch, as Node names them)
 *   node scripts/computer/build.ts --reuse <url>    # that release's, when it's the same program
 *   node scripts/computer/build.ts --source         # what the program is: its `source`
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  type Binary,
  binaryName,
  type Manifest,
  PLATFORMS,
} from "../../plugins/compute/computers/program/release.ts";
import { VERSION } from "../../plugins/compute/computers/program/version.ts";

const BUN = "bun@1.4.4";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROGRAM = join(ROOT, "plugins/compute/computers/program");
const OUT = join(ROOT, "dist/computer", VERSION);
const SCRIPTS = ["install.sh", "install.ps1"];

/** Runs a command, failing with what it said. */
const run = (command: string, args: string[]) =>
  new Promise<void>((done, failed) => {
    execFile(command, args, { cwd: ROOT, shell: process.platform === "win32" }, (error, _, err) => {
      if (error) failed(new Error(`${command} ${args.join(" ")}\n${err || error.message}`));
      else done();
    });
  });

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** What the program is, apart from its version (see above). */
async function sourceOf(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "copilotz-computer-"));
  try {
    const bundle = join(dir, "main.js");
    await run("npx", [
      "--yes",
      BUN,
      "build",
      "--target=bun",
      "--minify",
      join(PROGRAM, "main.ts"),
      "--outfile",
      bundle,
    ]);
    const parts = [
      `bun ${BUN}`,
      `targets ${PLATFORMS.map((p) => p.target).join(" ")}`,
      `main.js ${sha256((await readFile(bundle, "utf8")).replaceAll(VERSION, "<version>"))}`,
      ...await Promise.all(
        SCRIPTS.map(async (script) =>
          `${script} ${sha256(await readFile(join(PROGRAM, "install", script)))}`
        ),
      ),
    ];
    return sha256(parts.join("\n"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The release at `base`, into `OUT`, when it's this program (`source`) for
 * every platform asked: its binaries, checked by their size and SHA-256, and
 * its manifest. Else nothing.
 */
async function reused(
  base: string,
  source: string,
  platforms: readonly { os: string; arch: string }[],
): Promise<Manifest | undefined> {
  const from = base.endsWith("/") ? base : `${base}/`;
  const response = await fetch(new URL("manifest.json", from));
  if (!response.ok) {
    console.log(`${from}manifest.json: ${response.status}, so it's built`);
    return undefined;
  }
  const last = await response.json() as Manifest;
  if (last.source !== source) {
    console.log(`The program changed since ${last.version} (${from}): it's built`);
    return undefined;
  }
  const binaries = platforms.map((p) =>
    last.binaries.find((b) => b.os === p.os && b.arch === p.arch)
  );
  if (binaries.some((b) => !b)) {
    console.log(`${from} doesn't have every platform: it's built`);
    return undefined;
  }
  for (const binary of binaries as Binary[]) {
    const got = await fetch(new URL(binary.file, from));
    const bytes = new Uint8Array(await got.arrayBuffer());
    if (!got.ok || bytes.byteLength !== binary.size || sha256(bytes) !== binary.sha256) {
      throw new Error(`${from}${binary.file} isn't what its manifest says`);
    }
    await writeFile(join(OUT, binary.file), bytes, { mode: 0o755 });
    console.log(`${binary.file}  ${(binary.size / 1e6).toFixed(1)} MB  (${last.version}'s)`);
  }
  console.log(`The program is ${last.version}'s, unchanged: its binaries, not built again`);
  return { ...last, binaries: binaries as Binary[] };
}

/** Builds each platform's binary into `OUT`. */
async function built(platforms: readonly (typeof PLATFORMS)[number][]): Promise<Binary[]> {
  const binaries: Binary[] = [];
  for (const platform of platforms) {
    const file = binaryName(platform);
    const started = Date.now();
    await run("npx", [
      "--yes",
      BUN,
      "build",
      "--compile",
      "--minify",
      `--target=${platform.target}`,
      join(PROGRAM, "main.ts"),
      "--outfile",
      join(OUT, file),
    ]);
    if (platform.os === "darwin") {
      await run("codesign", ["--force", "--sign", "-", join(OUT, file)]);
    }
    const bytes = await readFile(join(OUT, file));
    binaries.push({
      os: platform.os,
      arch: platform.arch,
      file,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
    console.log(
      `${file}  ${(bytes.byteLength / 1e6).toFixed(1)} MB  (${
        ((Date.now() - started) / 1000).toFixed(1)
      } s)`,
    );
  }
  return binaries;
}

const { values, positionals: asked } = parseArgs({
  allowPositionals: true,
  options: { reuse: { type: "string" }, source: { type: "boolean" } },
});
if (values.source) {
  console.log(await sourceOf());
  process.exit(0);
}
const named = (p: { os: string; arch: string }) => `${p.os}-${p.arch}`;
const platforms = PLATFORMS.filter((p) => !asked.length || asked.includes(named(p)));
const unknown = asked.filter((name) => !PLATFORMS.some((p) => named(p) === name));
if (unknown.length || !platforms.length) {
  console.error(`No platform ${unknown.join(", ")}: one of ${PLATFORMS.map(named).join(", ")}`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const source = await sourceOf();
let made = values.reuse ? await reused(values.reuse, source, platforms) : undefined;
if (!made) {
  if (process.platform !== "darwin" && platforms.some((p) => p.os === "darwin")) {
    console.error("macOS binaries are signed on a Mac: build them there, or name the others");
    process.exit(1);
  }
  made = { version: VERSION, source, binaries: await built(platforms) };
}
// The same program has the same install scripts (they're in its `source`).
for (const script of SCRIPTS) await copyFile(join(PROGRAM, "install", script), join(OUT, script));
await writeFile(join(OUT, "manifest.json"), JSON.stringify(made, null, 2) + "\n");
const total = (await Promise.all(made.binaries.map((b) => stat(join(OUT, b.file)))))
  .reduce((sum, s) => sum + s.size, 0);
console.log(
  `${relative(ROOT, OUT)}/: ${made.binaries.length} binaries (${
    (total / 1e6).toFixed(0)
  } MB) of ${made.version}, install.sh, install.ps1, manifest.json`,
);
