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
    `import { documentPdf, type Drawn, exportFile, tableSheet } from "./export.js";
function barcodeWidth(item: Drawn): number {
  if ("text" in item || "line" in item || "rect" in item) return 0;
  return item.barcode ? item.width : 0;
}
const label = { barcode: "123", x: 8, y: 12, height: 20 };
barcodeWidth({ ...label, width: 200 });
documentPdf([[label]], { size: "receipt" });
import { textOf } from "./toolkit/table-sheet.js";
type Item = { price: number };
const rows: Item[] = [{ price: 12 }];
const sheet = tableSheet([{
  key: "price", title: "Price", align: "right",
  text: row => row.price.toFixed(2), render: row => row.price,
}], rows);
tableSheet<Item>([{ key: "price", title: "Price", align: "right", render: row => row.price }], rows);
textOf({ key: "price", title: "Price", align: "right", render: row => row.price }, rows[0]);
exportFile("csv", sheet, "items");`,
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
