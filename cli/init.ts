import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { template } from "./template.ts";

function version(): string {
  const url = new URL(import.meta.url);
  if (url.protocol === "file:") {
    return JSON.parse(readFileSync(new URL("../package.json", url), "utf8")).version;
  }
  const match = /\/@copilotz\/copilotz\/(?:v)?([^/]+)\//.exec(url.pathname);
  if (!match) throw new Error(`Cannot read the Copilotz version from ${url}`);
  return match[1];
}

/** Starts a project in an empty directory. Uses installed local dependencies when already present. */
export function init(root: string): void {
  mkdirSync(root, { recursive: true });
  if (readdirSync(root).some((entry) => entry !== "node_modules" && entry !== ".git")) {
    throw new Error(`Start in an empty directory: ${root}`);
  }
  for (const [name, body] of Object.entries(template(version()))) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, { flag: "wx" });
  }
  if (!existsSync(join(root, "node_modules", "copilotz"))) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(npm, ["install"], {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.status !== 0) {
      throw new Error(`Install the app's dependencies in ${root}, then run copilotz gen.`, {
        cause: result.error,
      });
    }
  }
}
