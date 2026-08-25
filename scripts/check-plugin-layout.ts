/**
 * Enforces physical ownership for concrete Copilotz plugins.
 *
 * @module
 */

const PRIMITIVE_CATEGORIES = Object.freeze(
  [
    "actions",
    "adapters",
    "collections",
    "processors",
    "resources",
    "authoring",
  ] as const,
);

export const CONCRETE_PLUGIN_ROOTS = Object.freeze(
  [
    "admin",
    "channel-core",
    "channel-discord",
    "channel-telegram",
    "channel-web",
    "channel-whatsapp",
    "channel-zendesk",
    "core",
    "core-collections",
    "knowledge",
    "llm",
    "memory",
    "schedule-core",
    "schedules",
    "server",
    "skills",
    "tool-builtin",
    "tool-deno",
    "tool-finance",
    "tool-mcp",
    "tool-openapi",
    "tool-persistent-terminal",
    "tool-web",
    "usage",
  ] as const,
);

const REQUIRED_ROOT_FILES = Object.freeze(
  [
    "README.md",
    "index.ts",
    "plugin.ts",
    "plugin.test.ts",
  ] as const,
);
const REQUIRED_PRIMITIVE_FILES = Object.freeze(
  [
    "README.md",
    "index.ts",
    "index.test.ts",
  ] as const,
);
const README_SECTIONS = Object.freeze(
  [
    "what it is",
    "why it exists",
    "how to use it",
    "how it works",
  ] as const,
);

async function kind(url: URL): Promise<"file" | "directory" | "missing"> {
  try {
    const stat = await Deno.stat(url);
    return stat.isFile ? "file" : stat.isDirectory ? "directory" : "missing";
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "missing";
    throw error;
  }
}

async function entries(url: URL): Promise<readonly Deno.DirEntry[]> {
  const result: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(url)) result.push(entry);
  return Object.freeze(
    result.sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function hasModuleDoc(source: string): boolean {
  const leading = source.match(/^\s*\/\*\*[\s\S]*?\*\//)?.[0];
  return Boolean(leading && /(?:^|\s)@module(?:\s|$)/.test(leading));
}

async function requireModuleDoc(
  url: URL,
  displayPath: string,
  failures: string[],
): Promise<void> {
  if (await kind(url) !== "file") return;
  if (!hasModuleDoc(await Deno.readTextFile(url))) {
    failures.push(`${displayPath}: missing leading @module documentation`);
  }
}

async function requireReadmeContract(
  url: URL,
  displayPath: string,
  failures: string[],
): Promise<void> {
  if (await kind(url) !== "file") return;
  const normalized = (await Deno.readTextFile(url)).toLowerCase();
  for (const section of README_SECTIONS) {
    if (!normalized.includes(`## ${section}`)) {
      failures.push(`${displayPath}: missing '## ${section}' section`);
    }
  }
}

async function validatePrimitiveCategory(
  pluginName: string,
  category: string,
  categoryUrl: URL,
  failures: string[],
): Promise<void> {
  const categoryPath = `plugins/${pluginName}/${category}`;
  const categoryIndex = new URL("index.ts", categoryUrl);
  if (await kind(categoryIndex) !== "file") {
    failures.push(`${categoryPath}/index.ts: missing category barrel`);
  } else {
    await requireModuleDoc(
      categoryIndex,
      `${categoryPath}/index.ts`,
      failures,
    );
  }

  let primitiveCount = 0;
  for (const entry of await entries(categoryUrl)) {
    if (entry.name === "index.ts" || entry.name === "internal") continue;
    if (!entry.isDirectory) {
      failures.push(
        `${categoryPath}/${entry.name}: category roots may contain only index.ts, internal/, and primitive directories`,
      );
      continue;
    }
    primitiveCount += 1;
    const primitivePath = `${categoryPath}/${entry.name}`;
    const primitiveUrl = new URL(`${entry.name}/`, categoryUrl);
    for (const required of REQUIRED_PRIMITIVE_FILES) {
      if (await kind(new URL(required, primitiveUrl)) !== "file") {
        failures.push(`${primitivePath}/${required}: missing required file`);
      }
    }
    await requireReadmeContract(
      new URL("README.md", primitiveUrl),
      `${primitivePath}/README.md`,
      failures,
    );
    await requireModuleDoc(
      new URL("index.ts", primitiveUrl),
      `${primitivePath}/index.ts`,
      failures,
    );
    const definitionFactory = category === "actions"
      ? "defineAction"
      : category === "collections"
      ? "defineCollection"
      : category === "processors"
      ? "defineProcessor"
      : undefined;
    if (definitionFactory) {
      const indexUrl = new URL("index.ts", primitiveUrl);
      if (
        await kind(indexUrl) === "file" &&
        !new RegExp(
          `\\b${definitionFactory}(?:\\s*<[^;(){}]+>)?\\s*\\(`,
        ).test(
          await Deno.readTextFile(indexUrl),
        )
      ) {
        failures.push(
          `${primitivePath}/index.ts: ${category} primitive must own its ${definitionFactory}(...) definition`,
        );
      } else if (await kind(indexUrl) === "file") {
        const source = await Deno.readTextFile(indexUrl);
        const ownedProperties = category === "actions"
          ? ["id", "execute"]
          : category === "collections"
          ? ["name", "schema"]
          : ["id", "on"];
        for (const property of ownedProperties) {
          const propertyPattern = property === "execute"
            ? /\bexecute\s*(?::|\()/
            : new RegExp(`\\b${property}\\s*:`);
          if (!propertyPattern.test(source)) {
            failures.push(
              `${primitivePath}/index.ts: ${category} primitive must declare its own '${property}' definition property`,
            );
          }
        }
      }
    }
  }
  if (primitiveCount === 0) {
    failures.push(`${categoryPath}: empty primitive category must be omitted`);
  }
}

/** Validates one concrete plugin root and returns stable, sorted failures. */
export async function validateConcretePlugin(
  pluginsRoot: URL,
  pluginName: string,
): Promise<readonly string[]> {
  const failures: string[] = [];
  const pluginUrl = new URL(`${pluginName}/`, pluginsRoot);
  const pluginPath = `plugins/${pluginName}`;
  if (await kind(pluginUrl) !== "directory") {
    return Object.freeze([`${pluginPath}: missing concrete plugin root`]);
  }

  for (const required of REQUIRED_ROOT_FILES) {
    if (await kind(new URL(required, pluginUrl)) !== "file") {
      failures.push(`${pluginPath}/${required}: missing required file`);
    }
  }
  await requireReadmeContract(
    new URL("README.md", pluginUrl),
    `${pluginPath}/README.md`,
    failures,
  );
  await requireModuleDoc(
    new URL("index.ts", pluginUrl),
    `${pluginPath}/index.ts`,
    failures,
  );
  const pluginModule = new URL("plugin.ts", pluginUrl);
  await requireModuleDoc(pluginModule, `${pluginPath}/plugin.ts`, failures);
  if (await kind(pluginModule) === "file") {
    const source = await Deno.readTextFile(pluginModule);
    const definePluginCalls = source.match(/\bdefinePlugin\s*\(/g)?.length ?? 0;
    if (definePluginCalls !== 1) {
      failures.push(
        `${pluginPath}/plugin.ts: expected exactly one definePlugin(...) composition call, found ${definePluginCalls}`,
      );
    }
    for (
      const primitiveFactory of [
        "defineAction",
        "defineCollection",
        "defineProcessor",
      ]
    ) {
      if (new RegExp(`\\b${primitiveFactory}\\s*\\(`).test(source)) {
        failures.push(
          `${pluginPath}/plugin.ts: composition module cannot define primitives with ${primitiveFactory}`,
        );
      }
    }
  }

  const allowedRootEntries = new Set<string>([
    ...REQUIRED_ROOT_FILES,
    ...PRIMITIVE_CATEGORIES,
    "internal",
  ]);
  for (const entry of await entries(pluginUrl)) {
    if (!allowedRootEntries.has(entry.name)) {
      failures.push(
        `${pluginPath}/${entry.name}: unexpected plugin-root entry`,
      );
      continue;
    }
    if (
      PRIMITIVE_CATEGORIES.includes(
        entry.name as (typeof PRIMITIVE_CATEGORIES)[number],
      )
    ) {
      if (!entry.isDirectory) {
        failures.push(
          `${pluginPath}/${entry.name}: category must be a directory`,
        );
      } else {
        await validatePrimitiveCategory(
          pluginName,
          entry.name,
          new URL(`${entry.name}/`, pluginUrl),
          failures,
        );
      }
    }
  }

  async function rejectDependencies(directory: URL, displayPath: string) {
    for (const entry of await entries(directory)) {
      const entryPath = `${displayPath}/${entry.name}`;
      if (entry.isDirectory && entry.name === "dependencies") {
        failures.push(`${entryPath}: use internal/ for private plugin code`);
      } else if (entry.isDirectory) {
        await rejectDependencies(
          new URL(`${entry.name}/`, directory),
          entryPath,
        );
      }
    }
  }
  await rejectDependencies(pluginUrl, pluginPath);

  return Object.freeze([...new Set(failures)].sort());
}

function selectedPluginNames(arguments_: readonly string[]): readonly string[] {
  const only = arguments_.find((argument) => argument.startsWith("--only="));
  if (!only) return CONCRETE_PLUGIN_ROOTS;
  const requested = only.slice("--only=".length).split(",").filter(Boolean);
  const unknown = requested.filter((name) =>
    !CONCRETE_PLUGIN_ROOTS.includes(
      name as (typeof CONCRETE_PLUGIN_ROOTS)[number],
    )
  );
  if (unknown.length) {
    throw new TypeError(
      `Unknown concrete plugin root(s): ${unknown.join(", ")}`,
    );
  }
  return Object.freeze(requested);
}

if (import.meta.main) {
  const pluginsRoot = new URL("../plugins/", import.meta.url);
  const failures: string[] = [];
  for (const pluginName of selectedPluginNames(Deno.args)) {
    failures.push(...await validateConcretePlugin(pluginsRoot, pluginName));
  }
  if (failures.length) {
    throw new Error(`Plugin layout check failed:\n${failures.join("\n")}`);
  }
}
