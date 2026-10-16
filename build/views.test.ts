import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { discover, emitPlugin, generate, inventory } from "./index.ts";
import { createPluginRegistry } from "../runtime/plugins/index.ts";

const config = { id: "fixture.views", version: "1" };

async function fixture(
  sources: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(
    fileURLToPath(new URL("./views-fixture-", import.meta.url)),
  );
  try {
    for (
      const [path, value] of Object.entries({
        "copilotz.json": JSON.stringify(config),
        ...sources,
      })
    ) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("View discovery uses ordinary leaves and never evaluates source", async () => {
  await fixture({
    "views/zebra/index.ts":
      'throw new Error("must not execute"); export default {};',
    "views/board-summary/index.ts": "export default {};",
    "views/board-summary/private/index.ts": "throw new Error('helper');",
    "views/shared/helper/index.ts": "throw new Error('shared');",
    "shared/views/ignored/index.ts": "throw new Error('shared');",
    "authoring/views/ignored/index.ts": "throw new Error('authoring');",
    "actions/save/index.ts": "export default {};",
  }, async (root) => {
    assert.deepEqual(
      (await discover(root, config)).map((entry) => [
        entry.path,
        entry.category,
        entry.alias,
      ]),
      [
        ["actions/save/index.ts", "actions", "save"],
        ["views/board-summary/index.ts", "views", "boardSummary"],
        ["views/zebra/index.ts", "views", "zebra"],
      ],
    );
    const first = await generate(root);
    assert.equal(await generate(root), first);
    assert.match(
      first,
      /views: \{\n {4}"boardSummary": entry1,\n {4}"zebra": entry2,/,
    );
    assert.doesNotMatch(first, /private|ignored|helper/);
  });
});

test("six-category inventory and emission are deterministic across caller ordering", () => {
  const sources = {
    "views/zebra/index.ts": "export default {};",
    "collections/board/index.ts": "export default {};",
    "processors/refresh/index.ts": "export default {};",
    "adapters/renderer/text/index.ts": "export default {};",
    "resources/views/prefer/index.ts": "export default {};",
    "views/alpha/index.ts": "export default {};",
    "actions/save/index.ts": "export default {};",
  };
  const forward = inventory(sources, config);
  const reverse = inventory(
    Object.fromEntries(Object.entries(sources).reverse()),
    config,
  );
  assert.deepEqual(forward, reverse);
  assert.deepEqual(
    [...new Set(forward.map((entry) => entry.category))].sort(),
    [
      "actions",
      "adapters",
      "collections",
      "processors",
      "resources",
      "views",
    ],
  );
  assert.equal(
    emitPlugin(config, forward),
    emitPlugin(config, reverse.reverse()),
  );
  assert.match(
    emitPlugin(config, forward),
    /resources: \{\n {4}"views": \{\n {6}"prefer": entry4,/,
  );
});

test("View leaves honor explicit selection and aliases", () => {
  const sources = {
    "views/board-summary/index.ts": "export default {};",
    "views/unused/index.ts": "export const ignored = true;",
  };
  const entries = inventory(sources, {
    ...config,
    include: ["views/board-summary/index.ts"],
    aliases: { "views/board-summary/index.ts": "summary" },
  });
  assert.deepEqual(entries, [{
    path: "views/board-summary/index.ts",
    category: "views",
    namespace: undefined,
    alias: "summary",
  }]);
  assert.match(emitPlugin(config, entries), /"summary": entry0/);
  assert.throws(
    () =>
      inventory(sources, { ...config, include: ["views/missing/index.ts"] }),
    /not discovered/,
  );
  assert.throws(
    () =>
      inventory(sources, {
        ...config,
        include: ["views/board-summary/index.ts"],
        aliases: { "views/missing/index.ts": "missing" },
      }),
    /not discovered/,
  );
});

test("View inventory rejects duplicate aliases, invalid aliases, and missing defaults", () => {
  assert.throws(() =>
    inventory({
      "views/foo-bar/index.ts": "export default {};",
      "views/fooBar/index.ts": "export default {};",
    }, config), /Duplicate views.fooBar/);
  assert.throws(
    () =>
      inventory({ "views/board/index.ts": "export const view = {};" }, config),
    /expected a default export/,
  );
  assert.throws(
    () =>
      inventory({ "views/board/index.ts": "export default {};" }, {
        ...config,
        aliases: { "views/board/index.ts": "__proto__" },
      }),
    /invalid alias/,
  );
});

test("generation without Views retains the existing composition source", () => {
  assert.equal(
    emitPlugin(
      config,
      inventory({ "actions/save/index.ts": "export default {};" }, config),
    ),
    [
      "// Generated by copilotz build. Edit source declarations, not this file.",
      'import { definePlugin, type DefinedPlugin } from "@copilotz/copilotz/plugins";',
      'import entry0 from "./actions/save/index.ts";',
      "const definition = {",
      '  id: "fixture.views",',
      '  version: "1",',
      "  actions: {",
      '    "save": entry0,',
      "  },",
      "} as const;",
      "const plugin: DefinedPlugin<typeof definition> = definePlugin(definition);",
      "export default plugin;",
      "",
    ].join("\n"),
  );
});

test("generated View composition installs through the real registry and package subpath", async () => {
  await fixture({
    "views/board-summary/index.ts": [
      'import { defineView } from "@copilotz/copilotz/views";',
      'export default defineView({ id: "fixture.board-summary", shows: "board", renderer: "text", modes: ["context"], render: () => "board summary" });',
    ].join("\n"),
    "actions/save/index.ts": [
      'import { defineAction } from "@copilotz/copilotz/actions";',
      'export default defineAction({ id: "fixture.save", execute: (value: unknown) => value });',
    ].join("\n"),
  }, async (root) => {
    const entry = join(root, "plugin.generated.ts");
    await writeFile(entry, await generate(root));
    const { default: plugin } = await import(pathToFileURL(entry).href);
    const registry = createPluginRegistry({ plugins: [plugin] });
    assert.equal(registry.views.boardSummary.id, "fixture.board-summary");
    assert.equal(registry.views.boardSummary.renderer, "text");
    assert.equal(
      await registry.actions.save.execute("saved", {} as never),
      "saved",
    );
  });
});

test("View fixture cleanup removes its directory when generation fails", async () => {
  let createdRoot = "";
  await assert.rejects(() =>
    fixture({
      "views/broken/index.ts": "export const missingDefault = true;",
    }, async (root) => {
      createdRoot = root;
      await generate(root);
    }), /expected a default export/);
  assert.ok(createdRoot);
  await assert.rejects(() => readFile(join(createdRoot, "copilotz.json")), {
    code: "ENOENT",
  });
});
