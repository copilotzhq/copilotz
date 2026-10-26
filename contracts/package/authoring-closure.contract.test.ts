import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const root = new URL("../../", import.meta.url);

/** Inspect emitted ESM, not an approximation of TypeScript's erased edges. */
function executableImports(source: string): readonly string[] {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
      verbatimModuleSyntax: true,
    },
  }).outputText;
  const tree = ts.createSourceFile("entry.js", output, ts.ScriptTarget.Latest);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier));
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      assert.fail(
        "Primitive authoring must not dynamically load implementations",
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return specifiers;
}

test("authoring closure distinguishes erased declarations from executable ESM edges", () => {
  assert.deepEqual(
    executableImports(`
    import type { SqlSession } from "./erased-import.ts";
    export type { SqlSession } from "./erased-export.ts";
    export type * from "./erased-star.ts";
    type Imported = typeof import("./erased-query.ts");
    import { type InlineType } from "./retained-empty-import.ts";
    export { type InlineType } from "./retained-empty-export.ts";
    import "./side-effect.ts";
    export * from "./barrel.ts";
    import { value, type Value } from "./mixed.ts";
  `),
    [
      "./retained-empty-import.ts",
      "./retained-empty-export.ts",
      "./side-effect.ts",
      "./barrel.ts",
      "./mixed.ts",
    ],
  );
  assert.throws(() => executableImports('import("./dynamic.ts")'));
  assert.throws(() => executableImports("import(path)"));
  assert.throws(() => executableImports('require("./required.ts")'));
});

test("primitive authoring runtime closure excludes persistence and protected-value hydration", async () => {
  const allowed = new Set([
    "runtime/actions/content.ts",
    "runtime/actions/define.ts",
    "runtime/actions/secret.ts",
    "runtime/actions/value.ts",
    "runtime/collections/authoring.ts",
    "runtime/collections/definition.ts",
    "runtime/collections/reads.ts",
    "runtime/collections/errors.ts",
    "runtime/content/decode.ts",
    "runtime/content/digest.ts",
    "runtime/content/errors.ts",
    "runtime/content/input.ts",
    "runtime/content/json.ts",
    "runtime/content/schema.ts",
    "runtime/data-only-json.ts",
    "runtime/events/types.ts",
    // Pure delivery-timeout constant and validator; no imports.
    "runtime/execution/deadlines.ts",
    "runtime/failure.ts",
    "runtime/json.ts",
    "runtime/plugins/contribution.ts",
    "runtime/plugins/processor.ts",
    "runtime/plugins/types.ts",
    "runtime/streams/json.ts",
    "runtime/views/definition.ts",
    "runtime/views/index.ts",
    "runtime/views/renderer.ts",
    "runtime/views/resolution.ts",
  ]);
  const pending = [
    "runtime/actions/define.ts",
    "runtime/collections/authoring.ts",
    "runtime/plugins/types.ts",
    "runtime/views/index.ts",
  ].map((path) => new URL(path, root));
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    const path = file.href.slice(root.href.length);
    if (visited.has(path)) continue;
    visited.add(path);
    assert.ok(allowed.has(path), `Primitive authoring reached ${path}`);
    for (const specifier of executableImports(await readFile(file, "utf8"))) {
      assert.ok(
        specifier.startsWith("."),
        `Primitive authoring loads an external implementation: ${path} -> ${specifier}`,
      );
      pending.push(new URL(specifier, file));
    }
  }
  assert.deepEqual([...visited].sort(), [...allowed].sort());
});
