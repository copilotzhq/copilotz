import type fixturePlugin from "./fixtures/root-authored-plugin.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import ts from "typescript";
import * as authoring from "../../authoring.ts";

const root = new URL("../../", import.meta.url);
const fixture = "contracts/package/fixtures/root-authored-plugin.ts";
// Deliberately fixture-only. A production worker entry must also supply the
// actual common factory; this resolver does not pretend that factory exists.
const allowed = new Set([
  "authoring.ts",
  fixture,
  "runtime/actions/content.ts",
  "runtime/actions/define.ts",
  "runtime/actions/secret.ts",
  "runtime/actions/value.ts",
  "runtime/collections/definition.ts",
  "runtime/content/decode.ts",
  "runtime/content/digest.ts",
  "runtime/content/errors.ts",
  "runtime/content/input.ts",
  "runtime/content/schema.ts",
  "runtime/events/types.ts",
  "runtime/json.ts",
  "runtime/plugins/contribution.ts",
  "runtime/plugins/processor.ts",
  "runtime/plugins/types.ts",
  "runtime/views/definition.ts",
  "runtime/views/index.ts",
  "runtime/views/renderer.ts",
  "runtime/views/resolution.ts",
]);

/** Emit every executable edge, without any bundler/tree-shaking elimination. */
async function emitArtifact(destination: string, sourceOverride?: string) {
  const seen = new Set<string>();
  const queue = [fixture];
  while (queue.length) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    assert.ok(
      allowed.has(path),
      `Unexpected executable authoring module: ${path}`,
    );
    seen.add(path);
    const source = path === fixture && sourceOverride !== undefined
      ? sourceOverride
      : await readFile(new URL(path, root), "utf8");
    let emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    const tree = ts.createSourceFile(
      path,
      emitted,
      ts.ScriptTarget.Latest,
      true,
    );
    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        const specifier = node.moduleSpecifier.text;
        let target: string;
        if (specifier === "@copilotz/copilotz") {
          // Reject unsupported values even when they are unused. An optimizer
          // dropping createCopilotz must not turn an invalid role into success.
          const bindings = ts.isImportDeclaration(node)
            ? node.importClause?.namedBindings
            : node.exportClause;
          assert.ok(
            bindings &&
              (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)),
            "Fixture root resolution requires explicit named authoring imports",
          );
          for (const entry of bindings.elements) {
            const name = (entry.propertyName ?? entry.name).text;
            assert.ok(name in authoring, `Unsupported runtime export: ${name}`);
          }
          target = "authoring.ts";
        } else {
          assert.ok(
            specifier.startsWith("."),
            `Unmapped runtime subpath: ${specifier}`,
          );
          const url = new URL(specifier, new URL(path, root));
          assert.ok(
            url.href.startsWith(root.href),
            "Import escapes repository",
          );
          target = url.href.slice(root.href.length);
        }
        assert.ok(
          allowed.has(target),
          `Unexpected executable authoring module: ${target}`,
        );
        queue.push(target);
        let mapped = relative(dirname(path), target).replaceAll("\\", "/")
          .replace(/\.ts$/, ".mjs");
        if (!mapped.startsWith(".")) mapped = "./" + mapped;
        edits.push({
          start: node.moduleSpecifier.getStart(tree),
          end: node.moduleSpecifier.end,
          text: JSON.stringify(mapped),
        });
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        assert.fail(`Dynamic executable import in ${path}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      emitted = emitted.slice(0, edit.start) + edit.text +
        emitted.slice(edit.end);
    }
    const output = join(destination, path.replace(/\.ts$/, ".mjs"));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, emitted);
  }
  return seen;
}

async function withArtifact(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "copilotz-authoring-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("root-authored whole-plugin artifact retains all six primitives without database runtime edges", async () => {
  await withArtifact(async (directory) => {
    const visited = await emitArtifact(directory);
    assert.deepEqual([...visited].sort(), [...allowed].sort());
    const { default: plugin, withoutViews, contributed } = await import(
      pathToFileURL(join(directory, fixture.replace(/\.ts$/, ".mjs"))).href
    );
    assert.equal(plugin.id, "artifact.whole");
    const typed: typeof fixturePlugin = plugin;
    assert.equal(typed.resources.formats.default.prefix, "Note: ");
    assert.deepEqual(Object.keys(withoutViews.views), []);
    assert.equal(contributed.resources.presentations.note.mode, "context");
    assert.equal(contributed.views.note.id, "artifact.note");
    const artifactUrl =
      pathToFileURL(join(directory, fixture.replace(/\.ts$/, ".mjs"))).href;
    const node = await promisify(execFile)("node", [
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      const { default: plugin, contributed, withoutViews } = await import(${
        JSON.stringify(artifactUrl)
      });
      assert.equal(await plugin.actions.echo.execute({ text: "node" }, { adapters: plugin.adapters }), "Note: node");
      assert.equal(contributed.views.note.render({ text: "view" }, {}), "view");
      assert.deepEqual(Object.keys(withoutViews.views), []);
      console.log("native-node-whole-plugin-ok");
    `,
    ]);
    assert.equal(node.stdout.trim(), "native-node-whole-plugin-ok");
    for (
      const category of [
        "actions",
        "collections",
        "processors",
        "resources",
        "adapters",
        "views",
      ]
    ) {
      assert.equal(Object.keys(plugin[category]).length, 1, category);
    }
    assert.equal(plugin.collections.notes.name, "artifact_notes");
    assert.equal(
      plugin.processors.observe.on[0].eventType,
      "artifact_notes.created",
    );
    assert.equal(plugin.resources.formats.default.prefix, "Note: ");
    assert.equal(
      await plugin.actions.echo.execute({ text: "hello" }, {
        adapters: plugin.adapters,
      }),
      "Note: hello",
    );
    assert.equal(
      await plugin.views.note.render({ text: "hello" }, {}),
      "hello",
    );
    const emitted = await readFile(join(directory, "authoring.mjs"), "utf8");
    assert.doesNotMatch(
      emitted,
      /createCopilotz|createCopilotzPersistence|SqlSession|ominipg|pglite/,
    );
  });
});

test("fixture role resolver refuses runtime exports, arbitrary subpaths and dynamic loading before optimization", async () => {
  const cases = [
    [
      'import { createCopilotz } from "@copilotz/copilotz"; export default {};',
      /Unsupported runtime export: createCopilotz/,
    ],
    [
      'import { createCopilotzPersistence } from "@copilotz/copilotz/persistence"; export default {};',
      /Unmapped runtime subpath/,
    ],
    [
      'import { definePlugin } from "@copilotz/copilotz/plugins"; export default {};',
      /Unmapped runtime subpath/,
    ],
    [
      'import "../../../runtime/persistence/index.ts"; export default {};',
      /Unexpected executable authoring module/,
    ],
    [
      'export default import("@copilotz/copilotz");',
      /Dynamic executable import/,
    ],
  ] as const;
  for (const [source, error] of cases) {
    await withArtifact((directory) =>
      assert.rejects(() => emitArtifact(directory, source), error)
    );
  }
});

test("shared authoring values preserve the public root bindings and ship with the root", async () => {
  const publicRoot = await import("../../index.ts");
  for (const [name, value] of Object.entries(authoring)) {
    assert.equal((publicRoot as Record<string, unknown>)[name], value, name);
  }
  assert.equal("createCopilotz" in authoring, false);
  assert.equal("createCopilotzPersistence" in authoring, false);
  const configuration = JSON.parse(
    await readFile(new URL("deno.json", root), "utf8"),
  );
  assert.ok(configuration.publish.include.includes("authoring.ts"));
  assert.equal(configuration.exports["./authoring"], undefined);
});
