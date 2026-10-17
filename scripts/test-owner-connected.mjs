/** Opt-in source-fixture runner. It never changes repository dependency pins. */
import { execFile, spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const OWNER_CONNECTED_USAGE =
  "Usage: node scripts/test-owner-connected.mjs --oxian-source PATH [--deno EXECUTABLE]\n" +
  "Alternatively set COPILOTZ_OXIAN_SOURCE_ROOT. An explicit Oxian source checkout is required.\n" +
  "Runs the private connected fixture with an ephemeral config; published pins remain unchanged.";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceExports = ["./hypervisor", "./worker", "./adapters/node"];
const execute = promisify(execFile);

export function parseOwnerConnectedArgs(args, env = process.env) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  let source;
  let deno = "deno";
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (!["--oxian-source", "--deno"].includes(option) || seen.has(option)) {
      throw new TypeError(`Unknown or repeated option: ${option}`);
    }
    seen.add(option);
    const value = args[++index];
    if (!value?.trim() || value.startsWith("--")) {
      throw new TypeError(`${option} requires a value.`);
    }
    if (option === "--oxian-source") source = value;
    else deno = value;
  }
  source ??= env.COPILOTZ_OXIAN_SOURCE_ROOT;
  if (!source?.trim()) {
    throw new TypeError(
      "Select an Oxian source checkout with --oxian-source PATH or COPILOTZ_OXIAN_SOURCE_ROOT.",
    );
  }
  return { help: false, source, deno };
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

async function json(path, label) {
  try {
    return object(JSON.parse(await readFile(path, "utf8")), label);
  } catch (error) {
    throw new Error(`Cannot read ${label} at ${path}: ${error.message}`, {
      cause: error,
    });
  }
}

async function containedFile(root, name) {
  const path = join(root, name);
  let canonical;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) {
      throw new Error("not a regular file");
    }
  } catch (error) {
    throw new Error(
      `Oxian checkout is missing required source file ${name}: ${error.message}`,
      { cause: error },
    );
  }
  const location = relative(root, canonical);
  if (
    location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location)
  ) {
    throw new Error(`Oxian source file escapes the selected checkout: ${name}`);
  }
  return canonical;
}

function fileBase(root) {
  return pathToFileURL(root + sep).href;
}

function rebase(specifier, root) {
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return new URL(specifier, fileBase(root)).href;
  }
  return specifier;
}

function imports(mapping, root, label) {
  return Object.fromEntries(
    Object.entries(object(mapping ?? {}, label)).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new TypeError(`${label}.${key} must be a string.`);
      }
      return [key, rebase(value, root)];
    }),
  );
}

function scopes(mapping, root, label) {
  return Object.fromEntries(
    Object.entries(object(mapping ?? {}, label)).map(([key, value]) => [
      rebase(key, root),
      imports(value, root, `${label}.${key}`),
    ]),
  );
}

/** Shared by the runner and fixture; public entries come from the selected manifest. */
export async function resolveOxianSource(source, cwd = process.cwd()) {
  let sourceRoot;
  try {
    sourceRoot = await realpath(resolve(cwd, source));
    if (!(await stat(sourceRoot)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (error) {
    throw new Error(
      `Oxian source checkout is unavailable: ${source}: ${error.message}`,
      { cause: error },
    );
  }
  const sourceManifest = await json(
    await containedFile(sourceRoot, "deno.json"),
    "Oxian manifest",
  );
  if (sourceManifest.name !== "@oxian/oxian-js") {
    throw new Error(
      "Selected source must be the @oxian/oxian-js checkout (deno.json name mismatch).",
    );
  }
  /** @type {Record<string, string>} */
  const entrypoints = {};
  for (const key of sourceExports) {
    const target = sourceManifest.exports?.[key];
    if (typeof target !== "string" || !target.startsWith("./")) {
      throw new Error(
        `Selected Oxian manifest must declare local export '${key}'.`,
      );
    }
    entrypoints[key] =
      pathToFileURL(await containedFile(sourceRoot, target)).href;
  }
  // Structural preflight only; the actual fixture also checks and exercises callHost.
  await containedFile(sourceRoot, "src/work/host-call-channel.ts");
  const siblingImports = imports(
    sourceManifest.imports,
    sourceRoot,
    "Oxian imports",
  );
  if (
    !/^npm:ws@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(
      siblingImports.ws ?? "",
    )
  ) {
    throw new Error(
      "The selected Oxian manifest must pin ws exactly as npm:ws@MAJOR.MINOR.PATCH.",
    );
  }
  return { sourceRoot, sourceManifest, siblingImports, entrypoints };
}

/** Validate the exact selected source directory before any test process starts. */
export async function prepareOwnerConnectedTest(
  { source, root = repositoryRoot, cwd = process.cwd() },
) {
  const { sourceRoot, sourceManifest, siblingImports, entrypoints } =
    await resolveOxianSource(source, cwd);
  root = await realpath(root);
  const manifest = await json(join(root, "deno.json"), "Copilotz manifest");
  if (manifest.name !== "@copilotz/copilotz") {
    throw new Error("Runner root must be the @copilotz/copilotz checkout.");
  }
  const testFiles = [
    "runtime/owner/connected.integration.test.ts",
    "runtime/owner/execution.connected.test.ts",
    "runtime/owner/preparation.connected.test.ts",
    "runtime/application/owner-host.test.ts",
    "runtime/application/owner-host.local.test.ts",
    "runtime/application/owner-host.processor.test.ts",
    "runtime/application/owner-host.capacity.test.ts",
    "runtime/application/owner-host.recovery.test.ts",
    "runtime/application/owner-host.startup.test.ts",
    "runtime/application/owner-host.preparation.test.ts",
    "runtime/application/owner-host.preparation-restart.test.ts",
    "plugins/channel-telegram/actions/send-text/transport.integration.test.ts",
    "runtime/application/owner-composition.connected.test.ts",
    "runtime/application/owner-composition.restart.test.ts",
    "build/role-bundle.connected.test.ts",
  ].map((path) => join(root, path));
  for (const testFile of testFiles) {
    if (!(await stat(testFile)).isFile()) {
      throw new Error("Connected owner fixture is missing.");
    }
  }
  const sourceScope = fileBase(sourceRoot);
  const siblingScopes = scopes(
    sourceManifest.scopes,
    sourceRoot,
    "Oxian scopes",
  );
  if (
    Object.keys(siblingScopes).some((scope) => !scope.startsWith(sourceScope))
  ) {
    throw new Error(
      "Oxian import scopes must stay inside the selected source checkout.",
    );
  }
  const config = {
    imports: imports(manifest.imports, root, "Copilotz imports"),
    scopes: {
      ...scopes(manifest.scopes, root, "Copilotz scopes"),
      ...siblingScopes,
      [sourceScope]: { ...siblingImports, ...siblingScopes[sourceScope] },
      ...Object.fromEntries([
        "runtime/application/owner-worker.ts",
        "runtime/application/owner-composition.ts",
        "runtime/application/owner-composition-types.ts",
      ].map((path) => [pathToFileURL(join(root, path)).href, {
        [pathToFileURL(join(root, "dependencies/oxian-worker.ts")).href]:
          entrypoints["./worker"],
      }])),
    },
    compilerOptions: manifest.compilerOptions,
    unstable: manifest.unstable,
    nodeModulesDir: manifest.nodeModulesDir,
    minimumDependencyAge: manifest.minimumDependencyAge,
    lock: false,
  };
  return {
    root,
    sourceRoot,
    testFile: testFiles[0],
    testFiles,
    config,
  };
}

/** Read-only provenance; a source archive remains usable when Git metadata is absent. */
export async function inspectOxianRevision(sourceRoot) {
  const prefix = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    sourceRoot,
  ];
  try {
    const checkout = await execute("git", [
      ...prefix,
      "rev-parse",
      "--show-toplevel",
    ]);
    if (await realpath(checkout.stdout.trim()) !== await realpath(sourceRoot)) {
      return undefined;
    }
    const revision = await execute("git", [
      ...prefix,
      "rev-parse",
      "HEAD",
      "HEAD^{tree}",
    ]);
    const status = await execute("git", [
      ...prefix,
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    const [head, tree] = revision.stdout.trim().split(/\r?\n/);
    return { head, tree, dirty: status.stdout.trim().length > 0 };
  } catch {
    return undefined;
  }
}

function runProcess(command, args, options) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      shell: false,
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    child.once("error", (error) => {
      cleanup();
      reject(
        new Error(`Cannot start test runtime '${command}': ${error.message}`, {
          cause: error,
        }),
      );
    });
    child.once("close", (code, signal) => {
      cleanup();
      done(
        code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1),
      );
    });
  });
}

/** runner injection is for setup tests; no configuration is written into either checkout. */
export async function runOwnerConnectedTests(
  options,
  runner = runProcess,
  report = console.log,
) {
  const plan = await prepareOwnerConnectedTest(options);
  const revision = await inspectOxianRevision(plan.sourceRoot);
  report(`Oxian fixture source: ${plan.sourceRoot}`);
  report(
    revision
      ? `Oxian revision: ${revision.head}; tree: ${revision.tree}; worktree: ${
        revision.dirty ? "dirty" : "clean"
      }`
      : "Oxian revision/tree/dirty status unavailable (Git metadata could not be read).",
  );
  report(
    `Copilotz published Oxian pin unchanged: ${
      plan.config.imports["@oxian/oxian-js"]
    }`,
  );
  const temporary = await mkdtemp(join(tmpdir(), "copilotz-owner-connected-"));
  try {
    const configPath = join(temporary, "deno.json");
    await writeFile(configPath, JSON.stringify(plan.config, null, 2) + "\n");
    return await runner(options.deno ?? "deno", [
      "test",
      "--config",
      configPath,
      "--allow-all",
      ...plan.testFiles,
    ], {
      cwd: plan.root,
      env: { ...process.env, COPILOTZ_OXIAN_SOURCE_ROOT: plan.sourceRoot },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const options = parseOwnerConnectedArgs(process.argv.slice(2));
    if (options.help) console.log(OWNER_CONNECTED_USAGE);
    else process.exitCode = await runOwnerConnectedTests(options);
  } catch (error) {
    console.error(`Owner connected fixture: ${error.message}`);
    process.exitCode = 1;
  }
}
