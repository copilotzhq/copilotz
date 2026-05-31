/**
 * CLI compiler for local Copilotz applications.
 *
 * This entrypoint writes a generated runtime wrapper and optionally invokes
 * `deno compile` so a project can ship a standalone assistant binary.
 *
 * @module
 */

import { basename, dirname, fromFileUrl, join } from "@std/path";
import defaultAsciiLogo from "./ascii-logo.ts";

interface CompileCliOptions {
  yes: boolean;
  out: string;
  namespace: string;
  databaseUrl: string;
  resourcePaths: string[];
  presets: string[];
  imports: string[];
  copilotzSpecifier: string;
  configPath?: string;
  target?: string;
  setupOnly: boolean;
}

const DEFAULT_IMPORTS = ["agents.copilotz"];
const LOCAL_ASCII_LOGO_TEMPLATE = `const asciiLogo = ${
  JSON.stringify(
    defaultAsciiLogo,
  )
};

export default asciiLogo;
`;

if (import.meta.main) {
  await main();
}

async function main() {
  const options = await resolveOptions(Deno.args);
  await scaffoldAsciiLogo();
  const entrypoint = await writeEntrypoint(options);

  if (options.setupOnly) {
    console.log(`[copilotz] wrote ${entrypoint}`);
    console.log(
      "[copilotz] setup complete; skipping compile because --setup-only was provided",
    );
    return;
  }

  await compileEntrypoint(entrypoint, options);
}

async function resolveOptions(args: string[]): Promise<CompileCliOptions> {
  const parsed = parseArgs(args);
  const cwdName = basename(Deno.cwd()) || "copilotz";
  const namespace = parsed.namespace ??
    await ask("Namespace", cwdName, parsed.yes);
  const databaseUrl = parsed.databaseUrl ??
    await ask("Database URL", defaultDatabaseUrl(namespace), parsed.yes);
  const resourcesDefault = await pathExists("resources") ? "./resources" : "";
  const resourcePaths = splitList(
    parsed.resourcePaths ??
      await ask("Resource paths", resourcesDefault, parsed.yes),
  );
  const presets = splitList(
    parsed.presets ?? await ask("Bundled presets", "", parsed.yes),
  );
  const imports = splitList(
    parsed.imports ??
      await ask("Resource imports", DEFAULT_IMPORTS.join(","), parsed.yes),
  );

  return {
    yes: parsed.yes,
    out: parsed.out ?? `${cwdName}-cli`,
    namespace,
    databaseUrl,
    resourcePaths,
    presets,
    imports,
    copilotzSpecifier: parsed.copilotzSpecifier ??
      await defaultCopilotzSpecifier(),
    configPath: parsed.configPath ?? await defaultDenoConfig(),
    target: parsed.target,
    setupOnly: parsed.setupOnly,
  };
}

function parseArgs(args: string[]) {
  const parsed: {
    yes: boolean;
    setupOnly: boolean;
    out?: string;
    namespace?: string;
    databaseUrl?: string;
    resourcePaths?: string;
    presets?: string;
    imports?: string;
    copilotzSpecifier?: string;
    configPath?: string;
    target?: string;
  } = { yes: false, setupOnly: false };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    const [key, inlineValue] = arg.split("=", 2);

    if (arg === "--yes" || arg === "-y") parsed.yes = true;
    else if (arg === "--setup-only") parsed.setupOnly = true;
    else if (key === "--out") {
      const value = readOptionValue("--out", inlineValue, args, index);
      parsed.out = value.value;
      index = value.index;
    } else if (key === "--namespace") {
      const value = readOptionValue("--namespace", inlineValue, args, index);
      parsed.namespace = value.value;
      index = value.index;
    } else if (key === "--db-url") {
      const value = readOptionValue("--db-url", inlineValue, args, index);
      parsed.databaseUrl = value.value;
      index = value.index;
    } else if (key === "--resources") {
      const value = readOptionValue("--resources", inlineValue, args, index);
      parsed.resourcePaths = value.value;
      index = value.index;
    } else if (key === "--presets") {
      const value = readOptionValue("--presets", inlineValue, args, index);
      parsed.presets = value.value;
      index = value.index;
    } else if (key === "--imports") {
      const value = readOptionValue("--imports", inlineValue, args, index);
      parsed.imports = value.value;
      index = value.index;
    } else if (key === "--copilotz-specifier") {
      const value = readOptionValue(
        "--copilotz-specifier",
        inlineValue,
        args,
        index,
      );
      parsed.copilotzSpecifier = value.value;
      index = value.index;
    } else if (key === "--config") {
      const value = readOptionValue("--config", inlineValue, args, index);
      parsed.configPath = value.value;
      index = value.index;
    } else if (key === "--target") {
      const value = readOptionValue("--target", inlineValue, args, index);
      parsed.target = value.value;
      index = value.index;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      Deno.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option ${arg}`);
    } else if (!parsed.out) {
      parsed.out = arg;
    }
  }

  return parsed;
}

function readOptionValue(
  option: string,
  inlineValue: string | undefined,
  args: string[],
  index: number,
) {
  if (inlineValue !== undefined) return { value: inlineValue, index };
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Expected value after ${option}`);
  }
  return { value, index: index + 1 };
}

function ask(label: string, defaultValue: string, yes: boolean) {
  if (yes || !Deno.stdin.isTerminal()) return defaultValue;
  const answer = prompt(`${label} [${defaultValue}]:`);
  return answer?.trim() || defaultValue;
}

function splitList(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function defaultDatabaseUrl(namespace: string) {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ??
    Deno.cwd();
  return `file://${join(home, ".copilotz", `${namespace}.db`)}`;
}

async function defaultDenoConfig() {
  return await pathExists("deno.json") ? "deno.json" : undefined;
}

async function defaultCopilotzSpecifier() {
  try {
    const text = await Deno.readTextFile("deno.json");
    const config = JSON.parse(text) as { imports?: Record<string, string> };
    if (config.imports?.copilotz) return "copilotz";
  } catch {
    // No local config. Fall through to the published package.
  }

  return "jsr:@copilotz/copilotz";
}

async function scaffoldAsciiLogo() {
  const path = join("scripts", "ascii-logo.ts");
  if (await pathExists(path)) return;
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, LOCAL_ASCII_LOGO_TEMPLATE);
  console.log(`[copilotz] wrote ${path}`);
}

async function writeEntrypoint(options: CompileCliOptions) {
  const entrypoint = join(".copilotz", "cli-entry.ts");
  await Deno.mkdir(dirname(entrypoint), { recursive: true });
  if (options.databaseUrl.startsWith("file://")) {
    await Deno.mkdir(dirname(fromFileUrl(options.databaseUrl)), {
      recursive: true,
    })
      .catch(() => undefined);
  }
  await Deno.writeTextFile(entrypoint, renderEntrypoint(options));
  console.log(`[copilotz] wrote ${entrypoint}`);
  return entrypoint;
}

function renderEntrypoint(options: CompileCliOptions) {
  return `import { createCopilotz } from ${
    JSON.stringify(options.copilotzSpecifier)
  };
import asciiLogo from "../scripts/ascii-logo.ts";

const copilotz = await createCopilotz({
  dbConfig: {
    url: Deno.env.get("DATABASE_URL") || ${JSON.stringify(options.databaseUrl)},
  },
  resources: {
    path: ${JSON.stringify(options.resourcePaths)},
    preset: ${JSON.stringify(options.presets)},
    imports: ${JSON.stringify(options.imports)},
  },
  namespace: Deno.env.get("COPILOTZ_NAMESPACE") || ${
    JSON.stringify(options.namespace)
  },
  agent: {
    llmOptions: {
      provider: Deno.env.get("LLM_PROVIDER") as never,
      model: Deno.env.get("LLM_MODEL") || undefined,
      reasoningEffort: Deno.env.get("LLM_REASONING_EFFORT") as never,
      maxTokens: Number(Deno.env.get("LLM_MAX_TOKENS")) || 100000,
      limitEstimatedInputTokens: Number(Deno.env.get("LLM_INPUT_TOKEN_LIMIT")) || 8000,
    },
  },
  assets: {
    config: {
      backend: "fs",
      namespacing: { mode: "context", includeInRef: true },
      fs: {
        rootDir: Deno.env.get("ASSETS_DIR") || "./assets",
      },
      resolveInLLM: true,
    },
  },
  multiAgent: {
    enabled: true,
    maxAgentTurns: Number(Deno.env.get("COPILOTZ_MAX_AGENT_TURNS")) || 20,
  },
});

let exitCode = 0;
const session = copilotz.start({ banner: asciiLogo });

try {
  await session.closed;
} catch (error) {
  exitCode = 1;
  console.error(error);
} finally {
  try {
    await copilotz.shutdown();
  } catch (error) {
    exitCode = 1;
    console.error(error);
  }
}

Deno.exit(exitCode);
`;
}

async function compileEntrypoint(
  entrypoint: string,
  options: CompileCliOptions,
) {
  const args = [
    "compile",
    "-A",
    "--env",
    "--no-check",
    ...(options.configPath ? [`--config=${options.configPath}`] : []),
    ...(options.target ? [`--target=${options.target}`] : []),
    "--include",
    "scripts/ascii-logo.ts",
    ...options.resourcePaths.flatMap((path) => localIncludeArgs(path)),
    "-o",
    options.out,
    entrypoint,
  ];

  console.log(`[copilotz] ${Deno.execPath()} ${args.join(" ")}`);
  const command = new Deno.Command(Deno.execPath(), {
    args,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await command.spawn().status;
  if (!status.success) {
    Deno.exit(status.code);
  }
}

function localIncludeArgs(path: string) {
  if (
    path.startsWith("jsr:") || path.startsWith("npm:") ||
    path.startsWith("https://")
  ) {
    return [];
  }
  return ["--include", path];
}

async function pathExists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`Compile a Copilotz terminal CLI.

Usage:
  deno run -A jsr:@copilotz/copilotz/scripts/compile-cli [options]

Options:
  --yes, -y                    Use defaults without prompting
  --setup-only                 Write generated files without compiling
  --out <path>                 Output executable path
  --namespace <name>           Copilotz namespace
  --db-url <url>               Database URL, defaults to file://~/.copilotz/<namespace>.db
  --resources <paths>          Comma-separated resource paths
  --presets <names>            Comma-separated bundled presets
  --imports <selectors>        Comma-separated resource imports
  --copilotz-specifier <spec>  Import specifier used by the generated CLI
  --config <path>              Deno config used for compile
  --target <target>            Deno compile target
`);
}
