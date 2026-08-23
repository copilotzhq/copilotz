import { assert, assertEquals, assertRejects } from "@std/assert";
import { fromFileUrl, join, relative } from "../../dependencies/std-path.ts";

import { createCopilotz } from "../../index.ts";

const repositoryRoot = fromFileUrl(new URL("../../", import.meta.url));
const canonicalEntries = [
  "runtime/adapters",
  "runtime/admin",
  "runtime/application",
  "runtime/attachments",
  "runtime/channels",
  "runtime/collections",
  "runtime/content",
  "runtime/domain",
  "runtime/engine",
  "runtime/events",
  "runtime/execution",
  "runtime/actions",
  "runtime/knowledge",
  "runtime/memory",
  "runtime/plugins",
  "runtime/skills",
  "runtime/tools",
  "runtime/agents",
  "runtime/llm",
  "plugins",
] as const;

async function collectProductionFiles(path: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const absolute = join(path, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectProductionFiles(absolute));
    } else if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) files.push(absolute);
  }
  return files;
}

Deno.test("v3 canonical runtime declares factories rather than local classes", async () => {
  const declarations: string[] = [];
  for (const entry of canonicalEntries) {
    for (
      const file of await collectProductionFiles(join(repositoryRoot, entry))
    ) {
      const source = await Deno.readTextFile(file);
      for (
        const match of source.matchAll(
          /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^\n{]*)/gm,
        )
      ) {
        if (/\bextends\s+Error\b/.test(match[2] ?? "")) continue;
        declarations.push(
          `${relative(repositoryRoot, file).replaceAll("\\", "/")}:${match[1]}`,
        );
      }
    }
  }
  assertEquals(declarations.sort(), []);
});

Deno.test("v3 root is a runtime-neutral composition barrel", async () => {
  const source = await Deno.readTextFile(
    new URL("../../index.ts", import.meta.url),
  );
  assert(!/\b(?:Deno|Bun|process)\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(
    !/database\/index|runtime\/index|loaders\/resources|resources\/core/.test(
      source,
    ),
  );
  assert(!/\bclass\s+\w+/.test(source));
});

Deno.test("retired executable and v1 server modules are deleted", async () => {
  for (
    const path of [
      "../../runtime/features/index.ts",
      "../../server/v1-fetch.ts",
      "../../server/v1-sse.ts",
    ]
  ) {
    await assertRejects(
      () => Deno.stat(new URL(path, import.meta.url)),
      Deno.errors.NotFound,
    );
  }
});

Deno.test("createCopilotz returns one frozen factory-created application", async () => {
  const application = await createCopilotz({
    namespace: "architecture-contract",
  });
  try {
    assertEquals(Object.getPrototypeOf(application), Object.prototype);
    assert(Object.isFrozen(application));
    assert(Object.isFrozen(application.config));
    for (
      const member of [
        "send",
        "observe",
        "close",
        "recover",
        "maintenance",
        "shutdown",
      ] as const
    ) assertEquals(typeof application[member], "function", member);
    for (const removed of ["db", "ops", "start", "embeddings", "schema"]) {
      assertEquals(removed in application, false, removed);
    }
  } finally {
    await application.shutdown();
    await application.shutdown();
  }
});
