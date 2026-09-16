/** Validates generated plugin ownership and convention manifests. @module */
import { type BuildConfig, discover, generate } from "../build/index.ts";
export const CONCRETE_PLUGIN_ROOTS = [
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
] as const;

const rootFiles = [
  "README.md",
  "index.ts",
  "plugin.ts",
  "copilotz.json",
  "plugin.generated.ts",
];
export async function validateConcretePlugin(
  pluginsRoot: URL,
  name: string,
): Promise<readonly string[]> {
  const root = new URL(name + "/", pluginsRoot);
  const failures: string[] = [];
  for (const file of rootFiles) {
    if (!await Deno.stat(new URL(file, root)).catch(() => null)) {
      failures.push(`plugins/${name}/${file}: missing required file`);
    }
  }
  if (failures.length) return failures;
  const config = JSON.parse(
    await Deno.readTextFile(new URL("copilotz.json", root)),
  ) as BuildConfig;
  try {
    const entries = await discover(root.pathname, config);
    for (const entry of entries) {
      const source = await Deno.readTextFile(new URL(entry.path, root));
      const primitive = {
        actions: "defineAction",
        collections: "defineCollection",
        processors: "defineProcessor",
      }[entry.category];
      if (
        primitive && !source.includes(primitive + "(") &&
        !source.includes(primitive + "<")
      ) failures.push(`${entry.path}: must own its ${primitive} definition`);
    }
    if (
      await generate(root.pathname) !==
        await Deno.readTextFile(new URL("plugin.generated.ts", root))
    ) {
      failures.push(
        `plugins/${name}/plugin.generated.ts: stale generated composition`,
      );
    }
  } catch (error) {
    failures.push(
      `plugins/${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const allowed = new Set([
    ...rootFiles,
    "plugin.test.ts",
    "internal",
    "actions",
    "collections",
    "processors",
    "resources",
    "adapters",
    "dependencies",
    "authoring",
  ]);
  for await (const entry of Deno.readDir(root)) {
    if (!allowed.has(entry.name)) {
      failures.push(
        `plugins/${name}/${entry.name}: unexpected plugin-root entry`,
      );
    }
  }
  return failures.sort();
}
if (import.meta.main) {
  const failures: string[] = [];
  for (const name of CONCRETE_PLUGIN_ROOTS) {
    failures.push(
      ...await validateConcretePlugin(
        new URL("../plugins/", import.meta.url),
        name,
      ),
    );
  }
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(
    `Validated ${CONCRETE_PLUGIN_ROOTS.length} convention-built plugin roots.`,
  );
}
