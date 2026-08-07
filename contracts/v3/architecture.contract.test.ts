import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join, relative } from "@std/path";

import { createCopilotz } from "@/index.ts";

const repositoryRoot = fromFileUrl(new URL("../../", import.meta.url));

const productionEntries = [
  "create",
  "database",
  "resources",
  "runtime",
  "server",
  "types",
  "utils",
] as const;

const allowedNonErrorClasses = [
  "resources/processors/tool_call/generators/mcp-generator.ts:MCPClient",
  "resources/tools/finance/provider/yahoo.ts:YahooProvider",
  "runtime/cli.ts:CopilotzInteractiveCli",
  "runtime/goal.ts:AsyncQueue",
  "runtime/index.ts:AsyncQueue",
  "runtime/llm/utils.ts:CanonicalToolCallDraftTracker",
  "runtime/tools/schema-to-agent-types.ts:GenericJsonSchemaToAgentTs",
].sort();

async function collectTypeScriptFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectTypeScriptFiles(absolute));
      continue;
    }
    if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      files.push(absolute);
    }
  }
  return files;
}

async function currentNonErrorClasses(): Promise<string[]> {
  const files = (
    await Promise.all(
      productionEntries.map((entry) =>
        collectTypeScriptFiles(join(repositoryRoot, entry))
      ),
    )
  ).flat();
  files.push(join(repositoryRoot, "index.ts"));

  const declarations: string[] = [];
  const classDeclaration =
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^\n{]*)/gm;

  for (const file of files) {
    const source = await Deno.readTextFile(file);
    for (const match of source.matchAll(classDeclaration)) {
      const name = match[1];
      const declarationTail = match[2] ?? "";
      if (/\bextends\s+Error\b/.test(declarationTail)) continue;
      declarations.push(
        `${relative(repositoryRoot, file).replaceAll("\\", "/")}:${name}`,
      );
    }
  }

  return declarations.sort();
}

Deno.test("A01 factory architecture locks current class debt and prevents growth", async () => {
  assertEquals(await currentNonErrorClasses(), allowedNonErrorClasses);
});

Deno.test("A01 createCopilotz returns a factory-created plain runtime", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
    agents: [{
      id: "contract-agent",
      name: "contract-agent",
      role: "assistant",
      instructions: "Characterization fixture.",
      llmOptions: { provider: "openai", model: "contract-model" },
    }],
    processors: [{
      eventType: "NEW_MESSAGE",
      shouldProcess: () => true,
      process: () => ({ producedEvents: [] }),
    }],
  });

  try {
    assertEquals(Object.getPrototypeOf(copilotz), Object.prototype);
    assert(Object.isFrozen(copilotz.config));
    assertEquals(Object.getPrototypeOf(copilotz.assets), Object.prototype);
    assertEquals(Object.getPrototypeOf(copilotz.embeddings), Object.prototype);

    for (
      const member of [
        "run",
        "goal",
        "recover",
        "start",
        "shutdown",
      ] as const
    ) {
      assertEquals(typeof copilotz[member], "function", member);
    }

    assertEquals(copilotz.ops, copilotz.db.ops);
    assert(copilotz.collections);
    assertEquals(typeof copilotz.collections.withNamespace, "function");
    assertEquals(typeof copilotz.schema.provision, "function");
    assertEquals(typeof copilotz.assets.getBase64, "function");
    assertEquals(typeof copilotz.embeddings.embed, "function");
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("A05 in-memory runtime ownership survives sequential factory lifecycles", async () => {
  const createRuntime = () =>
    createCopilotz({
      dbConfig: { url: ":memory:" },
      agents: [{
        id: "contract-agent",
        name: "contract-agent",
        role: "assistant",
        instructions: "Characterization fixture.",
        llmOptions: { provider: "openai", model: "contract-model" },
      }],
      processors: [{
        eventType: "NEW_MESSAGE",
        shouldProcess: () => true,
        process: () => ({ producedEvents: [] }),
      }],
    });

  const first = await createRuntime();
  await first.shutdown();
  await first.shutdown();

  const second = await createRuntime();
  try {
    assert(first.db !== second.db);
    const result = await second.db.query<{ value: number }>(
      "SELECT 1 AS value",
    );
    assertEquals(result.rows, [{ value: 1 }]);
  } finally {
    await second.shutdown();
    await second.shutdown();
  }
});
