/** Build against installed public exports only. No source aliases or internal paths. */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { demoFiles, installedFiles, sha256 } from "./package-proof.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "node_modules/@copilotz/copilotz");
const pkg = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);
const proof = JSON.parse(
  await readFile(resolve(root, ".package-proof.json"), "utf8"),
);
if (
  pkg.version !== proof.installedVersion || pkg.name !== proof.installedName
) throw new Error("Installed package differs from verified candidate.");
if (
  JSON.stringify(await installedFiles(packageRoot)) !==
    JSON.stringify(proof.installedFiles)
) throw new Error("Installed candidate files changed after verification.");
if (
  sha256(await readFile(resolve(root, "package-lock.json"))) !==
    proof.packageLockSha256
) throw new Error("Installed dependency lock changed after verification.");
if (
  JSON.stringify(await demoFiles(root)) !==
    JSON.stringify(proof.demoSourceFiles) ||
  sha256(JSON.stringify(proof.demoSourceFiles)) !== proof.demoSourceFilesSha256
) {
  throw new Error(
    "Demo source changed after installation. Use a fresh project copy and record a new installation proof.",
  );
}
const imports = {
  react: "npm:react@19.3.1",
  "react-dom/client": "npm:react-dom@19.3.1/client",
};
for (const [name, entry] of Object.entries(pkg.exports)) {
  const target = typeof entry === "string"
    ? entry
    : entry.import ?? entry.default;
  if (typeof target !== "string" || !target.startsWith("./")) {
    throw new Error(`Unsupported public export ${name}`);
  }
  imports[
    name === "." ? "@copilotz/copilotz" : `@copilotz/copilotz/${name.slice(2)}`
  ] = pathToFileURL(resolve(packageRoot, target)).href;
}
await mkdir(resolve(root, "dist"), { recursive: true });
const config = resolve(root, "dist/deno.json");
await writeFile(
  config,
  JSON.stringify(
    {
      imports,
      nodeModulesDir: "manual",
      compilerOptions: {
        lib: ["deno.ns", "dom", "dom.iterable", "esnext", "webworker"],
      },
    },
    null,
    2,
  ),
);
const deno = (args) => {
  const run = spawnSync(process.env.DENO_BIN ?? "deno", args, {
    cwd: root,
    stdio: "inherit",
  });
  if (run.status !== 0) {
    throw new Error(`Deno build failed: ${run.error ?? run.status}`);
  }
};
for (
  const [entry, output, platform] of [
    ["worker.ts", "worker.mjs", "browser"],
    ["browser.ts", "app.mjs", "browser"],
    ["adapters/llm/scripted/protocol.ts", "protocol.mjs", "browser"],
    ["view-host.ts", "view-host.mjs", "browser"],
    ["page.ts", "page.mjs", "browser"],
  ]
) {
  deno([
    "bundle",
    "--config",
    config,
    `--platform=${platform}`,
    entry,
    "-o",
    `dist/${output}`,
  ]);
}
const externals = Object.keys(imports).filter((name) =>
  name.startsWith("@copilotz/")
).flatMap((name) => ["--external", name]);
deno([
  "bundle",
  "--no-config",
  ...externals,
  "server.ts",
  "-o",
  "dist/server.mjs",
]);
deno([
  "bundle",
  "--no-config",
  ...externals,
  "owner.ts",
  "-o",
  "dist/owner.mjs",
]);
for (const name of ["index.html", "style.css"]) {
  await copyFile(resolve(root, name), resolve(root, "dist", name));
}
await writeFile(
  resolve(root, "dist/package-proof.json"),
  JSON.stringify(
    {
      ...proof,
      deno: spawnSync(process.env.DENO_BIN ?? "deno", ["--version"], {
        encoding: "utf8",
      }).stdout.trim(),
      browserAcceptance: "not established by build",
      imports,
    },
    null,
    2,
  ),
);
console.log(
  "Built the Node owner and real browser Worker/View bundles from the installed candidate. A successful build is not a browser pass.",
);
