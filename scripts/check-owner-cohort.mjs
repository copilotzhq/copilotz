/** Check public entries against explicitly selected, unpublished sibling sources. */
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  inspectOxianRevision,
  resolveOxianSource,
} from "./test-owner-connected.mjs";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const selections = {};
for (let index = 0; index < args.length; index += 2) {
  const option = args[index], value = args[index + 1];
  if (
    !["--oxian-source", "--ominipg-source"].includes(option) || !value ||
    value.startsWith("--") || selections[option]
  ) {
    throw new Error(
      "Usage: node scripts/check-owner-cohort.mjs --oxian-source PATH --ominipg-source PATH",
    );
  }
  selections[option] = value;
}
if (!selections["--oxian-source"] || !selections["--ominipg-source"]) {
  throw new Error(
    "Explicit Oxian and Ominipg source directories are required.",
  );
}
const oxian = await resolveOxianSource(selections["--oxian-source"]);
const ominipgRoot = await realpath(resolve(selections["--ominipg-source"]));
const manifest = JSON.parse(await readFile(join(root, "deno.json"), "utf8"));
const ominipgManifest = JSON.parse(
  await readFile(join(ominipgRoot, "deno.json"), "utf8"),
);
if (ominipgManifest.name !== "@oxian/ominipg") {
  throw new Error("The selected Ominipg checkout has the wrong package name.");
}
const base = (path) => pathToFileURL(path + sep).href;
const rebase = (mapping, path) =>
  Object.fromEntries(
    Object.entries(mapping ?? {}).map(([key, value]) => [
      key,
      value.startsWith("./") || value.startsWith("../")
        ? new URL(value, base(path)).href
        : value,
    ]),
  );
const imports = rebase(manifest.imports, root);
// npm: URLs cannot serve as URL-prefix mappings. Expand the package subpath
// used by the dependency facade explicitly, without changing its pinned version.
imports["jq-wasm/inline"] = `${imports["jq-wasm"]}/inline`;
for (const subpath of ["client", "client/stdio", "client/stdio.js"]) {
  imports[`@modelcontextprotocol/sdk/${subpath}`] = `${
    imports["@modelcontextprotocol/sdk"]
  }/${subpath}`;
}
const scopes = {};
const siblings = [
  { root: oxian.sourceRoot, manifest: oxian.sourceManifest },
  { root: ominipgRoot, manifest: ominipgManifest },
];
for (const sibling of siblings) {
  scopes[base(sibling.root)] = rebase(sibling.manifest.imports, sibling.root);
  for (const [key, value] of Object.entries(sibling.manifest.exports)) {
    imports[sibling.manifest.name + (key === "." ? "" : key.slice(1))] =
      new URL(value, base(sibling.root)).href;
  }
  console.log(`${sibling.manifest.name}: ${sibling.root}`);
  console.log(JSON.stringify(await inspectOxianRevision(sibling.root)));
}
for (const mapping of Object.values(scopes)) {
  for (const key of Object.keys(mapping)) {
    if (key.startsWith("@oxian/") && imports[key]) mapping[key] = imports[key];
  }
}
const temporary = await mkdtemp(join(tmpdir(), "copilotz-owner-cohort-"));
try {
  const map = join(temporary, "imports.json");
  await writeFile(map, JSON.stringify({ imports, scopes }));
  // Explicit import maps and --no-config prevent nested package manifests from
  // reintroducing published version pins into this source-cohort diagnostic.
  const flags = [
    "--no-config",
    `--import-map=${map}`,
    "--node-modules-dir=none",
  ];
  const entries = [...new Set(Object.values(manifest.exports))];
  const graph = await execute(
    "deno",
    ["info", "--json", ...flags, "index.ts"],
    {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const modules = JSON.parse(graph.stdout).modules;
  const failed = modules.filter((module) => module.error);
  if (failed.length) {
    throw new Error(
      `Dependency graph has unresolved modules: ${JSON.stringify(failed)}`,
    );
  }
  if (
    modules.some((module) =>
      /^https:\/\/jsr\.io\/@oxian\//.test(module.specifier)
    )
  ) {
    throw new Error(
      "The source graph still contains a published Oxian/Ominipg module.",
    );
  }
  for (const sibling of siblings) {
    if (
      !modules.some((module) => module.specifier.startsWith(base(sibling.root)))
    ) {
      throw new Error(
        `The source graph does not contain ${sibling.manifest.name}.`,
      );
    }
  }
  console.log(
    `Verified local cohort graph; checking ${entries.length} public entries.`,
  );
  const code = await new Promise((done, reject) => {
    const child = spawn("deno", ["check", ...flags, ...entries], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => done(code ?? 1));
  });
  process.exitCode = code;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
