const repositoryRoot = new URL("../", import.meta.url);
const configuration = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", repositoryRoot)),
) as {
  exports: Record<string, string>;
  imports: Record<string, string>;
};

const exportTargets = Object.values(configuration.exports);
for (const [subpath, target] of Object.entries(configuration.exports)) {
  const stat = await Deno.stat(new URL(target, repositoryRoot));
  if (!stat.isFile) {
    throw new Error(`Package export ${subpath} is not a file: ${target}`);
  }
}

const selfImports = Object.entries(configuration.imports).filter((
  [specifier],
) => specifier.startsWith("@copilotz/copilotz/"));
for (const [specifier, target] of selfImports) {
  if (!target.startsWith("./")) {
    throw new Error(
      `Package self-import ${specifier} must use a local target.`,
    );
  }
  const stat = await Deno.stat(new URL(target, repositoryRoot));
  if (!stat.isFile) {
    throw new Error(
      `Package self-import ${specifier} is not a file: ${target}`,
    );
  }
  if (!exportTargets.includes(target)) {
    throw new Error(
      `Package self-import ${specifier} does not match a public export target: ${target}`,
    );
  }
}

const check = new Deno.Command(Deno.execPath(), {
  args: ["check", ...exportTargets],
  cwd: repositoryRoot,
  stdout: "inherit",
  stderr: "inherit",
});
const checked = await check.output();
if (!checked.success) Deno.exit(checked.code);

async function* productionSources(
  directory: URL,
  prefix = "",
): AsyncGenerator<Readonly<{ path: string; text: string }>> {
  for await (const entry of Deno.readDir(directory)) {
    if ([".git", ".deno", "dist", "node_modules"].includes(entry.name)) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* productionSources(url, path);
    else if (
      entry.isFile && path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path.startsWith("contracts/") &&
      !path.startsWith("scripts/") &&
      !path.startsWith("runtime/testing/") &&
      !path.startsWith("plugins/core/testing/")
    ) yield { path, text: await Deno.readTextFile(url) };
  }
}

const production = [];
for await (const file of productionSources(repositoryRoot)) {
  production.push(file);
}

const decoder = new TextDecoder();
const lint = await new Deno.Command(Deno.execPath(), {
  args: ["lint", "--json", ...production.map((file) => file.path)],
  cwd: repositoryRoot,
  stdout: "piped",
  stderr: "piped",
}).output();
let lintReport: {
  diagnostics: readonly Readonly<{
    code: string;
    filename: string;
    message: string;
    range: Readonly<{ start: Readonly<{ line: number }> }>;
  }>[];
  errors: readonly unknown[];
};
try {
  lintReport = JSON.parse(decoder.decode(lint.stdout));
} catch {
  throw new Error(
    `Unable to read Deno lint report: ${decoder.decode(lint.stderr)}`,
  );
}
if (lintReport.errors.length) {
  throw new Error(
    `Deno lint failed to inspect ${lintReport.errors.length} files.`,
  );
}
const releaseLintRules = new Set([
  "no-slow-types",
  "no-unused-vars",
  "prefer-const",
  "require-await",
  "verbatim-module-syntax",
]);
const releaseDiagnostics = lintReport.diagnostics.filter((diagnostic) =>
  releaseLintRules.has(diagnostic.code)
);
if (releaseDiagnostics.length) {
  throw new Error(
    "Production release diagnostics:\n" + releaseDiagnostics.map(
      (diagnostic) =>
        `${diagnostic.filename}:${diagnostic.range.start.line + 1} ` +
        `[${diagnostic.code}] ${diagnostic.message}`,
    ).join("\n"),
  );
}

const graphOutputs = await Promise.all(
  exportTargets.map((target) =>
    new Deno.Command(Deno.execPath(), {
      args: ["info", "--json", target],
      cwd: repositoryRoot,
      stdout: "piped",
      stderr: "piped",
    }).output()
  ),
);
const reachableModules = new Set<string>();
for (const [index, output] of graphOutputs.entries()) {
  if (!output.success) {
    throw new Error(
      `Unable to inspect package graph for ${exportTargets[index]}: ` +
        decoder.decode(output.stderr),
    );
  }
  const graph = JSON.parse(decoder.decode(output.stdout)) as {
    modules: readonly Readonly<{ local?: string }>[];
  };
  for (const module of graph.modules) {
    if (module.local) reachableModules.add(module.local);
  }
}
const unreachableModules: string[] = [];
for (const file of production) {
  const path = await Deno.realPath(new URL(file.path, repositoryRoot));
  if (!reachableModules.has(path)) unreachableModules.push(file.path);
}
if (unreachableModules.length) {
  throw new Error(
    `Production modules unreachable from package exports: ${
      unreachableModules.sort().join(", ")
    }`,
  );
}

const dependencyDirectory = new URL("dependencies/", repositoryRoot);
const unusedDependencies: string[] = [];
for await (const entry of Deno.readDir(dependencyDirectory)) {
  if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
  const suffix = `dependencies/${entry.name}`;
  if (!production.some((file) => file.text.includes(suffix))) {
    unusedDependencies.push(entry.name);
  }
}
if (unusedDependencies.length) {
  throw new Error(
    `Unused dependency wrappers: ${unusedDependencies.sort().join(", ")}`,
  );
}

console.log(
  `Package surface passed: ${exportTargets.length} exports, ${selfImports.length} self-imports, ${production.length} production modules, and dependency wrappers are reachable and release-clean.`,
);
