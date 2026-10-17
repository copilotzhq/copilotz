import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const root = new URL("../../", import.meta.url);

test("registered Action and Processor worker runtime closure excludes database and body-store implementations", async () => {
  const allowed = new Set([
    "runtime/execution/registered-worker.ts",
    "runtime/execution/registered-processor.ts",
    "runtime/execution/child-action-port.ts",
    "runtime/plugins/match.ts",
    "runtime/application/owner-worker.ts",
    "dependencies/oxian-worker.ts",
    "runtime/owner/connection.ts",
    "runtime/execution/owner-port.ts",
    "runtime/execution/recovery.ts",
    "runtime/execution/execution-heartbeat.ts",
    "runtime/actions/execution-context.ts",
    "runtime/actions/effects.ts",
    "runtime/owner/effects-client.ts",
    "runtime/actions/secret.ts",
    "runtime/actions/deferral.ts",
    "runtime/actions/value.ts",
    "runtime/json.ts",
    "runtime/content/input.ts",
    "runtime/content/schema.ts",
    "runtime/content/errors.ts",
    "runtime/content/digest.ts",
    "runtime/collections/validate.ts",
    "runtime/collections/errors.ts",
    "runtime/failure.ts",
    "runtime/events/workflow-id.ts",
    "runtime/owner/transaction.ts",
    "dependencies/ajv.ts",
    "runtime/actions/transaction-identity.ts",
    "runtime/actions/protected-context.ts",
  ]);
  const visited = new Set<string>();
  const pending = [
    new URL("runtime/application/owner-worker.ts", root),
    new URL("runtime/execution/registered-worker.ts", root),
    new URL("runtime/execution/owner-port.ts", root),
  ];
  while (pending.length) {
    const file = pending.pop()!;
    const path = file.href.slice(root.href.length);
    if (visited.has(path)) continue;
    visited.add(path);
    assert.ok(
      allowed.has(path),
      `Registered worker reached unexpected runtime implementation: ${path}`,
    );
    const emitted = ts.transpileModule(await readFile(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ESNext,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    const tree = ts.createSourceFile(
      path,
      emitted,
      ts.ScriptTarget.Latest,
      true,
    );
    const add = (specifier: string) => {
      if (!specifier.startsWith(".")) {
        const dependencies: Record<string, readonly string[]> = {
          "dependencies/ajv.ts": ["ajv", "ajv-formats"],
          "dependencies/oxian-worker.ts": ["@oxian/oxian-js/worker"],
        };
        assert.ok(
          dependencies[path]?.includes(specifier),
          `Unexpected external worker implementation: ${path} -> ${specifier}`,
        );
        return;
      }
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
