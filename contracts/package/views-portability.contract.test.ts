/** First-party runtime graph contract; external package host checks retain their existing smoke tests. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const repository = new URL("../../", import.meta.url);

type Imports = Readonly<Record<string, string>>;

function executableImports(tree: ts.SourceFile): readonly string[] {
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isTypeNode(node)) return;
    if (ts.isImportDeclaration(node)) {
      if (node.importClause?.isTypeOnly) return;
      const bindings = node.importClause?.namedBindings;
      if (
        !node.importClause?.name && bindings && ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 && bindings.elements.every((item) =>
          item.isTypeOnly
        )
      ) return;
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly || !node.moduleSpecifier) return;
      const bindings = node.exportClause;
      if (
        bindings && ts.isNamedExports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((item) => item.isTypeOnly)
      ) return;
      imports.push((node.moduleSpecifier as ts.StringLiteral).text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return imports;
}

async function assertPortableGraph(
  entry: string,
  mappings: Imports,
): Promise<Set<string>> {
  const visited = new Set<string>();
  const pending = [new URL(entry, repository)];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current.href)) continue;
    visited.add(current.href);
    const path = current.href.slice(repository.href.length);
    assert.ok(
      !/^build\//.test(path),
      `Runtime graph reached ${path}`,
    );
    const tree = ts.createSourceFile(
      path,
      await readFile(current, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const inspect = (node: ts.Node): void => {
      if (ts.isTypeNode(node)) return;
      if (
        (ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression)
      ) {
        assert.ok(
          !["Deno", "Bun", "process"].includes(node.expression.text),
          `${path} uses host global ${node.expression.text}`,
        );
      }
      ts.forEachChild(node, inspect);
    };
    inspect(tree);
    for (const specifier of executableImports(tree)) {
      assert.ok(
        !/^node:/.test(specifier),
        `${path} imports host module ${specifier}`,
      );
      assert.ok(
        !/^(?:https?:|npm:|jsr:)/.test(specifier),
        `${path} bypasses centralized dependencies: ${specifier}`,
      );
      if (specifier.startsWith(".")) {
        pending.push(new URL(specifier, current));
      } else {
        const mapped = mappings[specifier] ??
          Object.entries(mappings).find(([name, target]) =>
            !name.startsWith("@copilotz/copilotz") &&
            !target.startsWith(".") && specifier.startsWith(name + "/")
          )?.[1];
        assert.ok(mapped, `${path} has unmapped import ${specifier}`);
        if (mapped.startsWith(".")) pending.push(new URL(mapped, repository));
      }
    }
  }
  return visited;
}

test("View subpath and root retain portable first-party executable import graphs", async () => {
  const configuration = JSON.parse(
    await readFile(new URL("deno.json", repository), "utf8"),
  ) as { imports: Imports };
  const viewUrl = new URL("runtime/views/index.ts", repository).href;
  const viewGraph = await assertPortableGraph(
    "runtime/views/index.ts",
    configuration.imports,
  );
  assert.ok(viewGraph.has(viewUrl));
  for (const url of viewGraph) {
    assert.ok(
      url.startsWith(new URL("runtime/views/", repository).href),
      `View graph reached outside its portable modules: ${url}`,
    );
  }
  const rootGraph = await assertPortableGraph(
    "index.ts",
    configuration.imports,
  );
  assert.ok(
    rootGraph.has(viewUrl),
    "The root must expose the actual View implementation",
  );
});
