/**
 * A fake CLI for the engine tests: an executable that runs a script beside
 * this file (a fake Claude Code, a fake ACP agent) on the runtime running
 * the tests, saying what it was started with to `log`. POSIX only: it's a
 * shell script.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runtime } from "../../../testing/mod.ts";

/** An executable `name` in `dir` that runs `script` (beside this file) on this runtime. */
export function fakeCli(dir: string, name: string, script: string, log: string) {
  const path = join(dir, name);
  const source = fileURLToPath(new URL(script, import.meta.url));
  const run = runtime === "deno"
    ? ["run", "-A", source]
    : runtime === "bun"
    ? ["run", source]
    : ["--no-warnings", source];
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    path,
    `#!/bin/sh\nexport FAKE_LOG=${quote(log)}\nexec ${
      [process.execPath, ...run].map(quote).join(" ")
    } "$@"\n`,
    { mode: 0o755 },
  );
  return path;
}
