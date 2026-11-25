import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import * as api from "../export.ts";
import { loadTsx } from "./load-tsx.ts";

const { Barcode } = await loadTsx(() => import("../toolkit/barcode.tsx"));

// SHA-256 of the actual bytes produced by 2383779c. Its PDF and ZIP writers have no timestamps.
const expected: Record<string, string> = JSON.parse(
  readFileSync(new URL("./rc63-exports.sha256.json", import.meta.url), "utf8"),
);

const sales: api.Sheet = {
  headers: ["Date", "Memo", "Amount"],
  rows: [
    ["2026-11-03", 'Café "São Paulo", counter 2', 14.75],
    ["2026-11-04", "Returns\n(credit)", -3.25],
    ["2026-11-04", "+1", -1e-7],
    ["2026-11-05", "-1e-7", ""],
    ["", "Total", 11.50],
  ],
};
const stock: api.Sheet = {
  headers: ["SKU", "Description", "Warehouse", "On hand", "Reserved", "Unit price"],
  rows: [
    ["000231", "O'Brien & Co. <small>", "SP-2", 84, 2, "12.50"],
    ["=A1", "A replacement\\spare", "MG", 5, 0, "-12.5"],
    ["@pending", "Unassigned stock", ""],
  ],
};
// Nine verbose fields compete with the quantity for the automatic column widths.
const purchase: api.Sheet = {
  headers: [
    "PO",
    "Supplier",
    "Item",
    "Description",
    "Qty",
    "Project",
    "Cost centre",
    "Ship to",
    "Terms",
    "Buyer",
  ],
  rows: [[
    "Regional contract purchase order (2026-1123)",
    "Northern Industrial Supplies and Components",
    "Replacement bearings for the auxiliary motor",
    "Machined to the approved engineering drawing",
    9,
    "Preventive maintenance and servicing project",
    "Central manufacturing operations department",
    "West receiving warehouse, loading entrance B",
    "Invoice on delivery, payable in thirty days",
    "Procurement office for the northern district",
  ]],
};
const ledger: api.Sheet = {
  headers: [
    "Date",
    "Origin",
    "Invoice",
    "Region",
    "Currency",
    "Net",
    "Tax",
    "Gross",
    "Paid",
    "Balance",
    "Due",
    "Notes",
  ],
  rows: Array.from({ length: 75 }, (_, i) => [
    "2026-11-01",
    "Web",
    1200 + i,
    i % 2 ? "Sul" : "Norte",
    "BRL",
    50,
    9,
    59,
    50,
    9,
    "2026-12-01",
    i % 3 ? "" : "Payment due on receipt — accounts payable",
  ]),
};
const reports = { sales, stock, purchase, ledger };
const cases = new Map<string, string | Uint8Array>();
for (const [name, sheet] of Object.entries(reports)) {
  for (const format of api.EXPORT_FORMATS) {
    const file = api.exportFile(format.format, sheet, name);
    // Include the filename and MIME type as well as the unmodified file payload.
    const payload = typeof file.content === "string"
      ? new TextEncoder().encode(file.content)
      : file.content;
    const prefix = new TextEncoder().encode(file.file + "\0" + file.type + "\0");
    const bytes = new Uint8Array(prefix.length + payload.length);
    bytes.set(prefix);
    bytes.set(payload, prefix.length);
    cases.set(name + "/" + format.format, bytes);
  }
}
cases.set("csv/no-bom", String(api.exportFile("csv", sales, "journal", { bom: false }).content));
cases.set("csv/formulas", api.toCsv(stock, { formulas: true }));
cases.set("csv/quoted", api.toCsv(sales));
cases.set("txt/no-bom", String(api.exportFile("txt", stock, "items", { bom: false }).content));
cases.set("xls/formulas", api.toExcel(stock, "A&B", { formulas: true }));
cases.set("xlsx/sheet-name", api.toXlsx(stock, "2026: November/stock"));
cases.set("json/records", api.toJson(stock));
cases.set("json/table", api.toJson(ledger, { json: "table" }));
cases.set("xml/stock", api.toXml(stock));
cases.set("sql/identifier", api.toSql(stock, "warehouse`stock"));
const jsLedger = { headers: ["Memo", "Paid", "Due", "Missing"], rows: [[null, true, false]] };
cases.set("sql/javascript-scalars", Reflect.apply(api.toSql, undefined, [jsLedger, "ledger"]));
cases.set("pdf/empty", api.toPdf({ headers: sales.headers, rows: [] }));
for (const orientation of ["landscape", "portrait"] as const) {
  const bytes = api.tablePdf(purchase, { orientation });
  assert.ok(new TextDecoder().decode(bytes).includes("(9) Tj"), orientation + " purchase quantity");
  cases.set("pdf/purchase-" + orientation, bytes);
  cases.set(
    "pdf/ledger-" + orientation,
    api.toPdf(ledger, {
      orientation,
      title: "November\nledger",
      fontSize: 10,
      headerColor: "#052",
      headerText: "#eee",
      stripeColor: null,
    }),
  );
}
cases.set(
  "document/invoice",
  api.documentPdf([[
    { text: "Invoice 102 — Café", x: 30, y: 10, font: "bold" },
    { line: [30, 35, 560, 35], thickness: 1.5 },
    { text: "Total € 12.50", x: 30, y: 44, width: 530, align: "right" },
  ], [{ rect: [35, 50, 25, 14], fill: "#ace", stroke: "#158" }]], { size: "letter" }),
);
cases.set(
  "document/receipt",
  api.documentPdf([[
    { text: "Order 0231", x: 12, y: 8 },
    { barcode: "POS 12", x: 12, y: 30, width: 147.5, height: 40.2, quiet: true },
  ]], { size: "receipt", margin: 8 }),
);
cases.set(
  "document/clipped-label",
  api.documentPdf([[
    { barcode: "SKU-12345", x: -15, y: 0, width: 120, height: 20, quiet: true },
  ]], { size: [120, 20] }),
);
for (
  const [value, width, quiet, set] of [
    ["POS 12", 300, true, "B"],
    ["001230456789", 95, false, "auto"],
    ["ORD-123456-A", 420.5, true, "auto"],
  ] as const
) {
  cases.set("code128/" + value, JSON.stringify(api.code128(value, { set })));
  cases.set("bars/" + value, JSON.stringify(api.bars(value, width, { quiet, set })));
  cases.set(
    "svg/" + value,
    renderToStaticMarkup(createElement(Barcode, {
      value,
      width,
      quiet,
      set,
      caption: true,
    })),
  );
}
test("rc.63 exports match the recorded bytes for every call", () => {
  assert.deepEqual([...cases.keys()].sort(), Object.keys(expected).sort());
  for (const [name, output] of cases) {
    assert.equal(createHash("sha256").update(output).digest("hex"), expected[name], name);
  }
});

test("SQL file exports use native null and booleans only with raw table values", () => {
  const legacy = cases.get("sql/javascript-scalars");
  const raw = { values: "raw" } as const;
  assert.equal(
    Reflect.apply(api.exportFile, undefined, ["sql", jsLedger, "ledger", raw]).content,
    legacy,
  );
  assert.equal(api.exportTableFile("sql", jsLedger, "ledger").content, legacy);
  assert.equal(
    api.exportTableFile("sql", jsLedger, "ledger", raw).content,
    "INSERT INTO `ledger` (`Memo`,`Paid`,`Due`,`Missing`) VALUES (NULL,TRUE,FALSE,'');",
  );
});

test("rc.63 JavaScript callers can attach their own sheet, options and barcode metadata", () => {
  const sheet = { headers: ["Amount"], rows: [[42]] };
  const invoice = { ...sheet, footerRows: [{ Amount: 42 }], keys: 17 };
  const options = { bom: false, pdf: { title: "Invoice" } };
  const metadata = {
    ...options,
    csv: { delimiter: "" },
    tableName: "unrelated",
    values: "raw",
    formats: { csv: "imported" },
    pdf: { ...options.pdf, columns: 42, titleLines: "private" },
  };
  assert.equal(Reflect.apply(api.toCsv, undefined, [invoice, metadata]), '"Amount"\n"42"');
  for (const { format } of api.EXPORT_FORMATS) {
    assert.deepEqual(
      api.exportFile(format, invoice, "invoice", metadata),
      api.exportFile(format, sheet, "invoice", options),
      format,
    );
  }
  assert.equal(api.toJson(invoice, metadata), api.toJson(sheet, options));
  assert.equal(api.toXml(invoice), api.toXml(sheet));
  assert.equal(api.toSql(invoice, "invoice"), api.toSql(sheet, "invoice"));
  assert.equal(api.toExcel(invoice, "invoice", metadata), api.toExcel(sheet, "invoice", options));
  assert.deepEqual(api.toXlsx(invoice, "invoice"), api.toXlsx(sheet, "invoice"));
  assert.deepEqual(api.toPdf(invoice, metadata.pdf), api.tablePdf(sheet, options.pdf));

  const label = { barcode: "SKU", x: 0, y: 0, width: 200, height: 30, quiet: true };
  const annotated = {
    ...label,
    value: label.barcode,
    image: "label.png",
    format: "ean8",
    check: 42,
  };
  assert.deepEqual(api.documentPdf([[annotated]]), api.documentPdf([[label]]));
  assert.deepEqual(api.bars("SKU", 200, annotated), api.bars("SKU", 200, label));
  assert.equal(
    renderToStaticMarkup(createElement(Barcode, annotated)),
    renderToStaticMarkup(createElement(Barcode, { ...label, value: label.barcode })),
  );
});
