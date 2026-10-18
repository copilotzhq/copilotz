/** Serial checked batching for development; not a replacement release gate. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TEST_ROOTS = Object.freeze([
  "contracts/package",
  "runtime",
  "plugins",
  "server",
  "client",
  "scripts",
  "build",
]);
const testName = /(?:^|[._])test\.(?:[cm]?[jt]sx?)$/;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_SUITE_USAGE =
  "Usage: node scripts/test-suite.mjs [--plan] [--root PATH] [--config PATH] " +
  "[--deno EXECUTABLE] [--batch-size 32] [--file RELATIVE_PATH ...] --output NEW_DIRECTORY\n" +
  "--plan prints inventory without launching tests or requiring --output.\n" +
  "--file selects scoped feedback, never the full retained suite. --batch-size 1 is the serial reference.";

export function parseTestSuiteArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const options = { batchSize: 32, files: [] };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--plan" && !seen.has(option)) {
      options.plan = true;
      seen.add(option);
      continue;
    }
    if (
      !["--root", "--config", "--deno", "--batch-size", "--file", "--output"]
        .includes(option) ||
      (option !== "--file" && seen.has(option))
    ) {
      throw new TypeError(`Unknown or repeated option: ${option}`);
    }
    seen.add(option);
    const value = args[++i];
    if (!value?.trim() || value.startsWith("--")) {
      throw new TypeError(`${option} requires a value`);
    }
    if (option === "--file") options.files.push(value);
    else if (option === "--batch-size") {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 128) {
        throw new TypeError(
          "--batch-size must be an integer from 1 through 128",
        );
      }
      options.batchSize = Number(value);
    } else options[option.slice(2)] = resolveOption(option, value);
  }
  if (!options.plan && !options.output) {
    throw new TypeError("--output NEW_DIRECTORY is required");
  }
  return options;
}
function resolveOption(option, value) {
  return option === "--deno" ? value : resolve(value);
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";

export async function prepareTestSuite(options = {}) {
  const root = await realpath(options.root ?? repositoryRoot);
  const manifest = JSON.parse(await readFile(join(root, "deno.json"), "utf8"));
  if (manifest.name !== "@copilotz/copilotz") {
    throw new Error("Expected a Copilotz repository");
  }
  const paths = [];
  async function walk(relative) {
    for (
      const entry of await readdir(join(root, relative), {
        withFileTypes: true,
      })
    ) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`Review symbolic link before discovery: ${path}`);
      }
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && testName.test(entry.name)) paths.push(path);
    }
  }
  for (const directory of TEST_ROOTS) await walk(directory);
  paths.sort();
  if (!paths.length) throw new Error("No retained test files discovered");
  const selected = options.files?.length ? [...options.files].sort() : paths;
  if (new Set(selected).size !== selected.length) {
    throw new Error("Repeated selected file");
  }
  for (const path of selected) {
    if (!paths.includes(path)) {
      throw new Error(`Selected file is not in retained inventory: ${path}`);
    }
  }
  const inventory = await Promise.all(paths.map(async (path) => ({
    path,
    sha256: hash(await readFile(join(root, path))),
  })));
  const batchSize = options.batchSize ?? 32;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 128) {
    throw new Error("Invalid batch size");
  }
  const batches = [];
  for (let i = 0; i < selected.length; i += batchSize) {
    batches.push(selected.slice(i, i + batchSize));
  }
  const config = options.config ? await realpath(options.config) : undefined;
  return {
    root,
    mode: options.files?.length
      ? "scoped-feedback"
      : "full-retained-suite-candidate",
    roots: TEST_ROOTS,
    exclusions: [],
    inventory,
    selected,
    batchSize,
    batches,
    config: config
      ? { path: config, sha256: hash(await readFile(config)) }
      : null,
    executable: options.deno ?? "deno",
    flags: ["test", ...(config ? ["--config", config] : []), "--allow-all"],
    concurrency: 1,
    releaseGate: false,
  };
}

/** No shell, parallel file workers, timeouts, filters, or checker bypasses.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd: string, env: Record<string, string | undefined>, stdout: string, stderr: string, signal?: AbortSignal}} options
 */
export async function runTestBatch(
  command,
  args,
  { cwd, env, stdout, stderr, signal },
) {
  const out = await open(stdout, "wx");
  let err;
  try {
    err = await open(stderr, "wx");
    const stopSignal = () => signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
    if (signal?.aborted) {
      return { exitCode: null, signal: stopSignal(), launched: false };
    }
    return await new Promise((done) => {
      let cancellationError;
      const grouped = process.platform !== "win32";
      const child = spawn(command, args, {
        cwd,
        env,
        shell: false,
        detached: grouped,
        stdio: ["ignore", out.fd, err.fd],
      });
      const stop = () => {
        try {
          if (grouped && child.pid) {
            process.kill(-child.pid, stopSignal());
          } else child.kill(stopSignal());
        } catch (error) {
          if (error.code !== "ESRCH") {
            cancellationError = error.message;
            // Keep failure evidence even if the child does not subsequently exit.
            try {
              writeSync(
                err.fd,
                `Cancellation delivery failed: ${error.message}\n`,
              );
            } catch {
              /* Preserve cancellationError in the eventual result too. */
            }
          }
        }
      };
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      let launchError;
      child.once("error", (error) => {
        launchError = error.message;
      });
      child.once("close", (exitCode, childSignal) => {
        signal?.removeEventListener("abort", stop);
        done({
          exitCode,
          signal: childSignal,
          ...(launchError ? { error: launchError } : {}),
          ...(cancellationError ? { cancellationError } : {}),
        });
      });
    });
  } finally {
    await out.close();
    await err?.close();
  }
}

/** Injection tests the scheduler without starting runtime/database workloads. */
export async function runTestSuite(plan, options, runner = runTestBatch) {
  const output = resolve(options.output);
  // An existing evidence directory is never overwritten, even after interruption.
  await mkdir(output);
  await writeFile(join(output, "plan.json"), json(plan), { flag: "wx" });
  const records = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  for (const [index, files] of plan.batches.entries()) {
    if (options.signal?.aborted) break;
    const id = `batch-${String(index + 1).padStart(4, "0")}`;
    const args = [...plan.flags, ...files];
    const stdout = join(output, `${id}.stdout.log`);
    const stderr = join(output, `${id}.stderr.log`);
    const record = {
      id,
      files,
      command: plan.executable,
      args,
      stdout,
      stderr,
      startedAt: new Date().toISOString(),
    };
    await writeFile(
      join(output, `${id}.json`),
      json({ ...record, status: "running" }),
      { flag: "wx" },
    );
    const before = performance.now();
    let result;
    try {
      result = await runner(plan.executable, args, {
        cwd: plan.root,
        env: options.env ?? process.env,
        stdout,
        stderr,
        signal: options.signal,
      });
    } catch (error) {
      result = { exitCode: null, signal: null, error: error.message };
    }
    const status = options.signal?.aborted || result.signal
      ? "interrupted"
      : result.error
      ? "launch-error"
      : result.exitCode === 0
      ? "passed"
      : "failed";
    records.push({
      ...record,
      ...result,
      status,
      finishedAt: new Date().toISOString(),
      elapsedSeconds: (performance.now() - before) / 1000,
    });
    await writeFile(join(output, `${id}.json`), json(records.at(-1)));
    // Retain failed attempts; never retry stateful files automatically.
    if (status === "interrupted") break;
  }
  const attempted = new Set(records.flatMap((record) => record.files));
  const summary = {
    mode: plan.mode,
    releaseGate: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedSeconds: (performance.now() - started) / 1000,
    status: records.length === plan.batches.length &&
        records.every((record) => record.status === "passed")
      ? "passed"
      : "incomplete-or-failed",
    batches: records,
    filesWithoutIndividualCompletionEvidence: records.filter((record) =>
      record.status !== "passed"
    ).flatMap((record) => record.files),
    unrunFiles: plan.selected.filter((file) => !attempted.has(file)),
    // No secret environment values or database credentials are serialized.
    backendSelection: {
      postgresConfigured: Boolean(
        (options.env ?? process.env).COPILOTZ_TEST_POSTGRES_URL,
      ),
      sourceConfigured: Boolean(
        (options.env ?? process.env).COPILOTZ_OXIAN_SOURCE_ROOT,
      ),
    },
  };
  await writeFile(join(output, "summary.json"), json(summary), { flag: "wx" });
  return summary;
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const options = parseTestSuiteArgs(process.argv.slice(2));
    if (options.help) console.log(TEST_SUITE_USAGE);
    else {
      const plan = await prepareTestSuite(options);
      if (options.plan) console.log(json(plan));
      else {
        const summary = await runTestSuite(plan, {
          ...options,
          signal: controller.signal,
        });
        console.log(
          `${summary.mode}: ${summary.status}; evidence: ${options.output}; not a release gate`,
        );
        process.exitCode = summary.status === "passed" ? 0 : 1;
      }
    }
  } catch (error) {
    console.error(`Test suite: ${error.message}`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
