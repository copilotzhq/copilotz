import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function installedFiles(
  root,
  ignored = new Set(["node_modules"]),
) {
  const files = {};
  async function scan(directory, prefix = "") {
    for (
      const entry of (await readdir(directory, { withFileTypes: true })).sort((
        a,
        b,
      ) => a.name.localeCompare(b.name))
    ) {
      if (entry.name === "node_modules" || ignored.has(prefix + entry.name)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        throw new Error("Unexpected symlink in verified file inventory.");
      }
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        await scan(join(directory, entry.name), relative + "/");
      } else if (entry.isFile()) {
        files[relative] = sha256(await readFile(join(directory, entry.name)));
      }
    }
  }
  await scan(root);
  return files;
}

const generated = new Set([
  "node_modules",
  "dist",
  "candidate.tgz",
  ".package-proof.json",
  "package-lock.json",
  ".npmrc",
  ".git",
]);
export const demoFiles = (root) => installedFiles(root, generated);
export function demoManifestMismatches(files, sourceFiles) {
  const prefix = "contracts/examples/owner-two-agents/";
  const recorded = Object.fromEntries(
    Object.entries(sourceFiles)
      .filter(([path, entry]) => path.startsWith(prefix) && !entry.deleted)
      .map(([path, entry]) => [path.slice(prefix.length), entry.sha256]),
  );
  return [...new Set([...Object.keys(files), ...Object.keys(recorded)])].sort()
    .filter((path) => files[path] !== recorded[path]);
}
