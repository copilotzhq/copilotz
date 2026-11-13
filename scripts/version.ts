/**
 * A release's version, everywhere it's said, in lockstep: Copilotz's deno.json
 * and package.json (and package-lock.json), the computer program's, and every
 * product package's deno.json (its version, and the Copilotz it imports) and
 * package.json; and where the README, AGENTS.md, the reference and the
 * computer's downloads name it.
 * The tag's version is the publish workflow's to check (`v<version>`), and
 * the changelog's heading the release's to write.
 *
 *   node scripts/version.ts 1.0.0-rc.33
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const next = process.argv[2];
if (!next || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error("version: say which, as x.y.z or x.y.z-pre (node scripts/version.ts 1.0.0-rc.33)");
  process.exit(1);
}
const now = (JSON.parse(readFileSync(join(ROOT, "deno.json"), "utf8")) as { version: string })
  .version;
const packages = readdirSync(join(ROOT, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => `packages/${entry.name}`);
const files = [
  "deno.json",
  "package.json",
  "package-lock.json",
  "plugins/compute/computers/program/version.ts",
  "plugins/compute/computers/resources/downloads.ts",
  "plugins/compute/tests/program-platform.test.ts",
  "README.md",
  "AGENTS.md",
  "docs/reference.md",
  // The agent plugin's manifests (skills/copilotz).
  ".claude-plugin/plugin.json",
  "plugin.json",
  "gemini-extension.json",
  ...packages.flatMap((dir) => [`${dir}/deno.json`, `${dir}/package.json`]),
];
const quoted = (version: string) => version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const file of files) {
  const path = join(ROOT, file);
  const text = readFileSync(path, "utf8");
  // The version where it's a version: quoted, after `@`, or a folder's name; never inside another.
  const changed = text.replace(new RegExp(`(?<=["@/^])${quoted(now)}(?=["/\`)\\s])`, "g"), next);
  if (changed === text) console.warn(`version: ${file} doesn't say ${now}`);
  writeFileSync(path, changed);
}
console.log(`${now} → ${next}: ${files.length} files`);
