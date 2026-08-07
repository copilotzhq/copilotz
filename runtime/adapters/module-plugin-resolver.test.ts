import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";

import { createPluginRegistry } from "../plugins/index.ts";
import { createModulePluginResolver } from "./module-plugin-resolver.ts";

Deno.test("module plugin resolver delegates absolute/package sources and resolves relative URLs", async () => {
  const imported: string[] = [];
  const resolver = createModulePluginResolver({
    baseUrl: "https://example.test/app/main.ts",
    resolveSpecifier(source) {
      return source === "alias:plugin" ? "jsr:@acme/plugin@^3" : source;
    },
    importModule(specifier) {
      imported.push(specifier);
      return Promise.resolve({ specifier });
    },
  });
  assertEquals(await resolver.resolve("./plugins/local.ts"), {
    specifier: "https://example.test/app/plugins/local.ts",
  });
  assertEquals(await resolver.resolve("alias:plugin"), {
    specifier: "jsr:@acme/plugin@^3",
  });
  assertEquals(imported, [
    "https://example.test/app/plugins/local.ts",
    "jsr:@acme/plugin@^3",
  ]);
});

Deno.test("injected native importer loads a plugin without filesystem APIs", async () => {
  const source = encodeURIComponent(`
    export default {
      manifest: { id: "data.plugin", version: "1.0.0", provides: {} },
      resources: {}
    };
  `);
  const resolver = createModulePluginResolver({
    importModule: (specifier) => import(specifier),
  });
  const registry = await createPluginRegistry({
    plugins: [`data:text/javascript,${source}`],
    resolver,
  });
  assertEquals(registry.plugins.map((plugin) => plugin.manifest.id), [
    "data.plugin",
  ]);
  await assertRejects(
    () => resolver.resolve("./relative.ts"),
    TypeError,
    "requires baseUrl",
  );
});

Deno.test("module plugin resolver requires an explicit host importer", () => {
  assertThrows(
    () => createModulePluginResolver(undefined!),
    TypeError,
    "requires a runtime module importer",
  );
});

Deno.test("module plugin resolver is factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("module-plugin-resolver.ts", import.meta.url),
  );
  assert(!/\bDeno\./.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/^\s*(?:export\s+)?class\s/m.test(source));
});
