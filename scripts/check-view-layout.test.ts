import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { generate } from "../build/index.ts";
import { validateConcretePlugin } from "./check-plugin-layout.ts";
import { findPluginBoundaryFailures } from "./check-plugin-boundaries.ts";
import { coreOwnershipErrors } from "./check-core-ownership.ts";

async function viewPlugin(
  declaration: string,
  run: (plugins: URL) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "copilotz-view-layout-"));
  const plugins = pathToFileURL(directory + "/");
  const root = new URL("example/", plugins);
  try {
    await mkdir(new URL("views/summary/", root), { recursive: true });
    await writeFile(
      new URL("copilotz.json", root),
      JSON.stringify({ id: "example", version: "1" }),
    );
    for (const name of ["README.md", "index.ts", "plugin.ts"]) {
      await writeFile(new URL(name, root), "");
    }
    await writeFile(new URL("views/summary/index.ts", root), declaration);
    await writeFile(
      new URL("plugin.generated.ts", root),
      await generate(root.pathname),
    );
    await run(plugins);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("concrete plugin layout accepts an owned View leaf", async () => {
  await viewPlugin(
    [
      'import { defineView } from "@copilotz/copilotz/views";',
      'export default defineView({id:"example.summary",shows:"note",renderer:"text",modes:["context"],render:()=>"summary"});',
    ].join("\n"),
    async (plugins) => {
      assert.deepEqual(await validateConcretePlugin(plugins, "example"), []);
    },
  );
});

test("concrete plugin layout requires a View leaf to own its defineView call", async () => {
  await viewPlugin(
    'export { default } from "../../shared/view.ts";',
    async (plugins) => {
      assert.deepEqual(await validateConcretePlugin(plugins, "example"), [
        "views/summary/index.ts: must own its defineView definition",
      ]);
    },
  );
});

const mappings = {
  imports: { "@copilotz/copilotz/views": "./runtime/views/index.ts" },
  exports: { "./views": "./runtime/views/index.ts" },
};

test("View leaves use the same public-import boundary as other primitives", () => {
  const runtime = {
    path: "runtime/views/index.ts",
    text: "export const defineView = () => {};",
  };
  assert.deepEqual(
    findPluginBoundaryFailures([
      {
        path: "plugins/example/views/summary/index.ts",
        text: 'import { defineView } from "@copilotz/copilotz/views";',
      },
      runtime,
    ], mappings),
    [],
  );
  const failures = findPluginBoundaryFailures([
    {
      path: "plugins/example/views/summary/index.ts",
      text: 'import { defineView } from "../../../../runtime/views/index.ts";',
    },
    runtime,
  ], mappings);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /plugin relative-imports runtime/);
});

test("the generic runtime cannot import a plugin View implementation", () => {
  const failures = findPluginBoundaryFailures([
    {
      path: "runtime/views/index.ts",
      text:
        'export { default } from "../../plugins/example/views/summary/index.ts";',
    },
    {
      path: "plugins/example/views/summary/index.ts",
      text: "export default {};",
    },
  ], mappings);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /runtime reaches concrete plugin/);
});

test("Core authoring helpers cannot construct module-level View instances", () => {
  const failures = coreOwnershipErrors(
    "plugins/core/authoring/context/index.ts",
    'export const summary = defineView({id:"core.summary"});',
  );
  assert.equal(failures.length, 1);
  assert.match(
    failures[0],
    /primitive instances belong to their primitive modules/,
  );
  assert.deepEqual(
    coreOwnershipErrors(
      "plugins/core/authoring/context/index.ts",
      'export function defineSummary(){return defineView({id:"core.summary"});}',
    ),
    [],
  );
  assert.deepEqual(
    coreOwnershipErrors(
      "plugins/core/views/summary/index.ts",
      'export default defineView({id:"core.summary"});',
    ),
    [],
  );
});
