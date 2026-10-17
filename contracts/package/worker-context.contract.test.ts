import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const root = new URL("../../", import.meta.url);

test("Action execution context runtime closure contains only capability assembly", async () => {
  const allowed = new Set([
    "runtime/actions/execution-context.ts",
    "runtime/actions/transaction-identity.ts",
    "runtime/actions/protected-context.ts",
  ]);
  const visited = new Set<string>();
  const pending = [new URL("runtime/actions/execution-context.ts", root)];
  while (pending.length) {
    const file = pending.pop()!;
    const path = file.href.slice(root.href.length);
    if (visited.has(path)) continue;
    visited.add(path);
    assert.ok(
      allowed.has(path),
      `Execution context reached unexpected runtime implementation: ${path}`,
    );
    const tree = ts.createSourceFile(
      path,
      await readFile(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const add = (specifier: string) => {
      assert.ok(
        specifier.startsWith("."),
        `Execution context imports external implementation ${specifier}`,
      );
      pending.push(new URL(specifier, file));
    };
    const visit = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        if (clause?.isTypeOnly) return;
        const bindings = clause?.namedBindings;
        if (
          !clause?.name && bindings && ts.isNamedImports(bindings) &&
          bindings.elements.length && bindings.elements.every((value) =>
            value.isTypeOnly
          )
        ) return;
        add((node.moduleSpecifier as ts.StringLiteral).text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        if (node.isTypeOnly) return;
        const bindings = node.exportClause;
        if (
          bindings && ts.isNamedExports(bindings) && bindings.elements.length &&
          bindings.elements.every((value) => value.isTypeOnly)
        ) return;
        add((node.moduleSpecifier as ts.StringLiteral).text);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        assert.fail(
          `${path} must not dynamically load runtime implementations`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual([...visited].sort(), [...allowed].sort());
});
