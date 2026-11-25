import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Runs gen with fresh module and package-import caches after the app or its imports change. */
export function regenerate(root: string, cli: string): void {
  const args = process.versions.deno
    ? [
      "run",
      "-A",
      ...(existsSync(join(root, "node_modules/copilotz")) ? ["--node-modules-dir=manual"] : []),
      cli.replace(
        /^https:\/\/jsr\.io\/(@copilotz\/copilotz)\/([^/]+)\/cli\/(?:mod|bin)\.ts$/,
        "jsr:$1@$2/gen",
      ),
    ]
    : [...process.execArgv, fileURLToPath(cli)];
  const child = spawnSync(process.execPath, [...args, "gen"], { cwd: root, stdio: "inherit" });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error("Generation failed.");
}
