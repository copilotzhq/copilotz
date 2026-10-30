/**
 * The computer program's release, built from its sources into
 * `dist/computer/<version>/` (the version is `program/version.ts`'s): a
 * single executable per platform, compiled by Bun, its install scripts, and
 * `manifest.json`, which says the version and each binary's file, size and
 * SHA-256 (see `program/release.ts`). An app serves that folder as it is, at
 * `/computer/download/` (or from a release or a bucket: the computers
 * plugin's `computerDownloads`), and its computers update themselves to it.
 *
 * Runs on Node 24 (and Deno, Bun); Bun comes from npm. macOS binaries are
 * signed ad hoc (`codesign -s -`), as macOS needs (Bun's own signature
 * doesn't hold once the program is in it), so they're built on a Mac:
 * elsewhere, name the other platforms.
 *
 *   node scripts/computer/build.ts                  # every platform
 *   node scripts/computer/build.ts darwin-arm64     # some (os-arch, as Node names them)
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
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

/** Runs a command, failing with what it said. */
const run = (command: string, args: string[]) =>
  new Promise<void>((done, failed) => {
    execFile(command, args, { cwd: ROOT, shell: process.platform === "win32" }, (error, _, err) => {
      if (error) failed(new Error(`${command} ${args.join(" ")}\n${err || error.message}`));
      else done();
    });
  });

const named = (p: { os: string; arch: string }) => `${p.os}-${p.arch}`;
const asked = process.argv.slice(2);
const platforms = PLATFORMS.filter((p) => !asked.length || asked.includes(named(p)));
const unknown = asked.filter((name) => !PLATFORMS.some((p) => named(p) === name));
if (unknown.length || !platforms.length) {
  console.error(`No platform ${unknown.join(", ")}: one of ${PLATFORMS.map(named).join(", ")}`);
  process.exit(1);
}
const mac = process.platform === "darwin";
if (!mac && platforms.some((p) => p.os === "darwin")) {
  console.error("macOS binaries are signed on a Mac: build them there, or name the others");
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
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
  if (platform.os === "darwin") await run("codesign", ["--force", "--sign", "-", join(OUT, file)]);
  const bytes = await readFile(join(OUT, file));
  binaries.push({
    os: platform.os,
    arch: platform.arch,
    file,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  console.log(
    `${file}  ${(bytes.byteLength / 1e6).toFixed(1)} MB  (${
      ((Date.now() - started) / 1000).toFixed(1)
    } s)`,
  );
}
for (const script of ["install.sh", "install.ps1"]) {
  await copyFile(join(PROGRAM, "install", script), join(OUT, script));
}
const manifest: Manifest = { version: VERSION, binaries };
await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const total = (await Promise.all(binaries.map((b) => stat(join(OUT, b.file)))))
  .reduce((sum, s) => sum + s.size, 0);
console.log(`${relative(ROOT, OUT)}/: ${binaries.length} binaries (${(total / 1e6).toFixed(0)} MB),
  install.sh, install.ps1, manifest.json`);
