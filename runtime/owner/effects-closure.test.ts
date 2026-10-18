import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

test("emitted effect client closure includes JSON validation only, with no owner SQL implementation", async () => {
  const sideEffectImport =
    ts.transpileModule('import { type Capability } from "./must-remain.ts";', {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
      },
    }).outputText;
  assert.match(sideEffectImport, /from ["']\.\/must-remain\.ts["']/);
  const root = new URL("../", import.meta.url);
  const allowed = new Set(["owner/effects-client.ts", "json.ts"]);
  const seen = new Set<string>();
  const pending = [new URL("effects-client.ts", import.meta.url)];
  while (pending.length) {
    const file = pending.pop()!;
    const name = file.href.slice(root.href.length);
    if (seen.has(name)) continue;
    seen.add(name);
    assert.ok(allowed.has(name), `Unexpected runtime dependency: ${name}`);
    const emitted = ts.transpileModule(await readFile(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    const tree = ts.createSourceFile(
      name,
      emitted,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        const specifier = (node.moduleSpecifier as ts.StringLiteral).text;
        assert.ok(
          specifier.startsWith("."),
          `Unexpected external dependency: ${specifier}`,
        );
        pending.push(new URL(specifier, file));
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) assert.fail("Dynamic effect implementation import");
      ts.forEachChild(node, visit);
    };
    visit(tree);
    assert.doesNotMatch(
      emitted,
      /owner_receipts|owner_epochs|SqlSession|BEGIN TRANSACTION/,
    );
  }
  assert.deepEqual([...seen].sort(), [...allowed].sort());
});
