/** Verify and install the exact artifact. This never publishes a package. */
import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  demoFiles,
  demoManifestMismatches,
  installedFiles,
} from "./package-proof.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarball = process.argv[2] && resolve(process.argv[2]);
const sourceRoot = process.argv[3] && resolve(process.argv[3]);
if (!tarball) {
  throw new Error(
    "Usage: node scripts/install-candidate.mjs EXACT_CANDIDATE.tgz [EXACT_SOURCE_CHECKOUT]",
  );
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifact = JSON.parse(
  await readFile(resolve(dirname(tarball), "artifact-manifest.json"), "utf8"),
);
const source = JSON.parse(
  await readFile(resolve(dirname(tarball), "source-manifest.json"), "utf8"),
);
if (hash(await readFile(tarball)) !== artifact.sha256) {
  throw new Error("Artifact hash mismatch.");
}
if (hash(JSON.stringify(source.files)) !== source.sourceFilesSha256) {
  throw new Error("Source manifest hash mismatch.");
}
if (
  artifact.sourceFilesSha256 !== source.sourceFilesSha256 ||
  artifact.head !== source.head || artifact.tree !== source.tree
) throw new Error("Artifact/source manifest provenance mismatch.");
for (const [path, entry] of Object.entries(sourceRoot ? source.files : {})) {
  if (path.startsWith("/") || path.split("/").includes("..")) {
    throw new Error("Invalid manifest path.");
  }
  let bytes;
  try {
    bytes = await readFile(resolve(sourceRoot, path));
  } catch (error) {
    if (entry.deleted && error.code === "ENOENT") continue;
    throw error;
  }
  if (entry.deleted || hash(bytes) !== entry.sha256) {
    throw new Error(`Exact source differs: ${path}`);
  }
}
try {
  await stat(resolve(root, "node_modules/@copilotz/copilotz"));
  throw new Error(
    "A candidate is already installed. Use a fresh project copy for another install; use npm run build to rebuild this one.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(resolve(root, ".npmrc"), "@jsr:registry=https://npm.jsr.io\n");
await copyFile(tarball, resolve(root, "candidate.tgz"));
const demoSourceFiles = await demoFiles(root);
const demoSourceMismatches = demoManifestMismatches(
  demoSourceFiles,
  source.files,
);
const installed = spawnSync("npm", [
  "install",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
], { cwd: root, stdio: "inherit" });
if (installed.status !== 0) throw new Error("Candidate install failed.");
const pkg = JSON.parse(
  await readFile(
    resolve(root, "node_modules/@copilotz/copilotz/package.json"),
    "utf8",
  ),
);
await writeFile(
  resolve(root, ".package-proof.json"),
  JSON.stringify(
    {
      candidateSha256: artifact.sha256,
      demoSourceFiles,
      demoSourceFilesSha256: hash(JSON.stringify(demoSourceFiles)),
      demoMatchesRuntimeSource: demoSourceMismatches.length === 0,
      demoSourceMismatches,
      sourceFilesSha256: source.sourceFilesSha256,
      sourceHead: source.head,
      sourceTree: source.tree,
      sourceCheck: sourceRoot
        ? "compared-with-checkout"
        : "recorded-builder-manifest",
      installedName: pkg.name,
      installedVersion: pkg.version,
      node: process.version,
      installedFiles: await installedFiles(
        resolve(root, "node_modules/@copilotz/copilotz"),
      ),
      packageLockSha256: hash(
        await readFile(resolve(root, "package-lock.json")),
      ),
    },
    null,
    2,
  ) + "\n",
);
if (demoSourceMismatches.length) {
  console.warn(
    `DIAGNOSTIC ONLY: ${demoSourceMismatches.length} demo files differ from the runtime builder manifest. Repack the final composition before acceptance.`,
  );
}
console.log(
  `Exact candidate installed; ${
    sourceRoot
      ? "source compared with checkout"
      : "builder source manifest recorded (checkout not compared)"
  }. Run npm run build, npm test, then npm start.`,
);
