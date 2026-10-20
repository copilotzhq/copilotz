import ts from "typescript";
import assert from "node:assert/strict";
import { test } from "node:test";
import { moduleSpecifiers } from "../../scripts/check-plugin-boundaries.ts";
const root = new URL("../../", import.meta.url);
const configuration = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", root)),
);
const framework =
  /(?:^|[/@:])(?:react|react-dom|vue|svelte|preact|solid-js|angular|radix-ui|tailwindcss|shadcn)(?:[/@-]|$)/;
async function graph(entry: string, neutral: boolean) {
  const pending = [new URL(entry, root)], visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file.href)) continue;
    visited.add(file.href);
    const source = await Deno.readTextFile(file);
    const tree = ts.createSourceFile(
      file.pathname,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTypeNode(node)) return;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const clause = ts.isImportDeclaration(node) ? node.importClause : node;
        if (clause?.isTypeOnly) return;
        const bindings = ts.isImportDeclaration(node)
          ? node.importClause?.namedBindings
          : node.exportClause;
        if (
          bindings &&
          (ts.isNamedImports(bindings) || ts.isNamedExports(bindings)) &&
          bindings.elements.length && bindings.elements.every((item) =>
            item.isTypeOnly
          )
        ) return;
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
      }
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      ) imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(tree);
    for (const specifier of neutral ? moduleSpecifiers(source) : imports) {
      if (neutral) {
        assert.ok(
          !framework.test(specifier),
          `${file.pathname} imports UI ${specifier}`,
        );
      }
      const resolved = configuration.imports[specifier] ?? specifier;
      if (neutral) {
        assert.ok(
          !framework.test(resolved),
          `${file.pathname} reaches UI ${resolved}`,
        );
      }
      if (resolved.startsWith(".")) {
        pending.push(
          new URL(resolved, specifier.startsWith(".") ? file : root),
        );
      }
    }
  }
  return visited;
}
test("every core entry import graph is UI-framework free, including type dependencies", async () => {
  for (const target of Object.values(configuration.exports) as string[]) {
    if (target.startsWith("./plugins/") || target.startsWith("./build/")) {
      continue;
    }
    await graph(target, true);
  }
});
test("browser plugin entries reach the shared kit and never server implementation closures", async () => {
  for (
    const target of [
      "./plugins/core/web.ts",
      "./plugins/admin/web.ts",
      "./plugins/usage/web.ts",
      "./plugins/ui/web.ts",
    ]
  ) {
    const files = [...await graph(target, false)];
    assert.ok(files.some((file) => file.includes("/plugins/ui-kit/")));
    assert.ok(
      !files.some((file) =>
        /\/(?:server|runtime\/(?:engine|persistence))\//.test(file)
      ),
      target,
    );
    assert.ok(
      !files.some((file) =>
        /\/plugins\/(?:core|admin|usage)\/actions\//.test(file)
      ),
      target,
    );
  }
});
