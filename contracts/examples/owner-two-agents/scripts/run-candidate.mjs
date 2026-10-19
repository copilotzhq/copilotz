import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [artifact, source] = process.argv.slice(2);
if (!artifact || !process.env.COPILOTZ_TEST_POSTGRES_URL) {
  throw new Error(
    "Usage: COPILOTZ_TEST_POSTGRES_URL=... node scripts/run-candidate.mjs EXACT_CANDIDATE.tgz [EXACT_SOURCE_CHECKOUT]",
  );
}
for (
  const args of [
    [
      "scripts/install-candidate.mjs",
      resolve(artifact),
      ...(source ? [resolve(source)] : []),
    ],
    ["scripts/build.mjs"],
    [
      "--test",
      ...(await readdir(resolve(cwd, "tests"))).filter((name) =>
        name.endsWith(".test.mjs")
      ).sort().map((name) => `tests/${name}`),
    ],
    ["dist/server.mjs"],
  ]
) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  const stop = () => child.kill("SIGINT");
  process.once("SIGINT", stop);
  const status = await new Promise((done, fail) => {
    child.once("error", fail);
    child.once("exit", (code) => done(code));
  });
  process.removeListener("SIGINT", stop);
  if (status !== 0) {
    process.exitCode = 1;
    break;
  }
}
