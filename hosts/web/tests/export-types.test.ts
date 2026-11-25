import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { tempDir, test } from "../../../testing/mod.ts";

test("a server can use web/export declarations without installing React types", () => {
  const dir = tempDir();
  const root = fileURLToPath(new URL("../", import.meta.url));
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ESNext,
    strict: true,
    types: [],
    allowImportingTsExtensions: true,
  };
  const declarations = ts.createProgram([join(root, "export.ts")], {
    ...options,
    rootDir: root,
    outDir: dir,
    declaration: true,
    emitDeclarationOnly: true,
    noCheck: true,
  });
  assert.equal(declarations.emit().emitSkipped, false);
  const app = join(dir, "app.ts");
  writeFileSync(
    app,
    'import { exportFile } from "./export.js";\nexportFile("csv", {headers: [], rows: []}, "items");',
  );
  const consumer = ts.createProgram([app], {
    ...options,
    noEmit: true,
    lib: ["lib.esnext.d.ts"],
    skipLibCheck: false,
  });
  assert.deepEqual(
    ts.getPreEmitDiagnostics(consumer).map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n")
    ),
    [],
  );
});
