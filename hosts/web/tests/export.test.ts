/**
 * A table as a file, in every format, made with no library: CSV quotes its
 * cells and never lets one run as a formula; `.xlsx` is a real zip (its
 * structure and CRCs right) whose sheet has numbers as numbers and text
 * escaped; the PDF's cross-reference points at its objects and it has a
 * page per page of rows; JSON, XML, SQL and the HTML `.xls` escape what
 * they must.
 */
import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import {
  exportFile,
  guard,
  type Sheet,
  toCsv,
  toExcel,
  toJson,
  toSql,
  toXlsx,
  toXml,
} from "../toolkit/export.ts";
import { barcodePng, pdfImage, tableSheet } from "../export.ts";
import { tablePdf, winAnsi } from "../toolkit/pdf.ts";
import { crc32, zip } from "../toolkit/zip.ts";

const sheet: Sheet = {
  headers: ["Name", "Total", "Code"],
  rows: [
    ['Ann "the" <boss> & co', "12.50", "007"],
    ["=HYPERLINK(1)", -3.5, "+1"],
    ["@sum", "-12.5", "-x"],
  ],
};

/** A zip's entries, read back: name, stored data, and the CRC it says. */
function unzip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  assertEquals(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assertEquals(view.getUint32(at, true), 0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.slice(at + 46, at + 46 + nameLength));
    assertEquals(view.getUint32(local, true), 0x04034b50);
    assertEquals(view.getUint16(local + 8, true), 0, "stored");
    assertEquals(view.getUint32(local + 14, true), crc);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, data: bytes.slice(start, start + size), crc });
    at += 46 + nameLength;
  }
  return entries;
}

test("CRC-32 is zip's, and a zip reads back with every file's CRC right", () => {
  assertEquals(crc32("123456789"), 0xcbf43926);
  assertEquals(crc32(new Uint8Array()), 0);
  const entries = unzip(
    zip([{ name: "a.txt", content: "Olá" }, {
      name: "b/c.bin",
      content: new Uint8Array([0, 255]),
    }]),
  );
  assertEquals(entries.map((e) => e.name), ["a.txt", "b/c.bin"]);
  for (const entry of entries) assertEquals(crc32(entry.data), entry.crc);
  assertEquals(new TextDecoder().decode(entries[0].data), "Olá");
});

test("xlsx: an Office workbook whose sheet has numbers as numbers, text escaped, never formulas", () => {
  const entries = unzip(toXlsx(sheet, "Sales: 2026/11"));
  assertEquals(entries.map((e) => e.name), [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  for (const entry of entries) assertEquals(crc32(entry.data), entry.crc);
  const text = (name: string) =>
    new TextDecoder().decode(entries.find((e) => e.name === name)!.data);
  assertStringIncludes(text("xl/workbook.xml"), 'name="Sales  2026 11"');
  const xml = text("xl/worksheets/sheet1.xml");
  assertStringIncludes(
    xml,
    '<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>',
  );
  assertStringIncludes(xml, "Ann &quot;the&quot; &lt;boss&gt; &amp; co");
  assertStringIncludes(xml, '<c r="B2"><v>12.50</v></c>');
  assertStringIncludes(xml, '<c r="B3"><v>-3.5</v></c>');
  assertStringIncludes(xml, '<c r="C2" t="inlineStr"><is><t xml:space="preserve">007</t></is></c>');
  assertStringIncludes(xml, '<t xml:space="preserve">=HYPERLINK(1)</t>');
  assert(!xml.includes("<f>"), "no formulas");
});

test("raw XLSX keeps decimal strings distinct and writes numbers as numeric cells", () => {
  const first = "123456789012345.671";
  const second = "123456789012345.672";
  const sheet = tableSheet(
    [{ key: "value", title: "Value" }],
    [{ value: first }, { value: second }, { value: 12.5 }],
    [{ value: "12.50" }],
    "raw",
  );
  const { content } = exportFile("xlsx", sheet, "values", { values: "raw" });
  assert(content instanceof Uint8Array);
  const entry = unzip(content).find((e) => e.name === "xl/worksheets/sheet1.xml");
  assert(entry);
  const xml = new TextDecoder().decode(entry.data);
  for (const [ref, value] of [["A2", first], ["A3", second], ["A5", "12.50"]]) {
    assertStringIncludes(
      xml,
      `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${value}</t></is></c>`,
    );
  }
  assertStringIncludes(xml, '<c r="A4"><v>12.5</v></c>');
});

test("CSV quotes every cell and guards formulas, but not plain numbers", () => {
  assertEquals(guard("=1+1"), "'=1+1");
  assertEquals(guard("-12.5"), "-12.5");
  assertEquals(guard("-x"), "'-x");
  assertEquals(
    toCsv(sheet),
    [
      '"Name","Total","Code"',
      '"Ann ""the"" <boss> & co","12.50","007"',
      `"'=HYPERLINK(1)","-3.5","+1"`,
      `"'@sum","-12.5","'-x"`,
    ].join("\n"),
  );
  assertStringIncludes(toCsv(sheet, { formulas: true }), '"=HYPERLINK(1)"');
});

test("CSV and TXT preserve raw and written numbers and guard formula-like text", () => {
  const values = [-1e-7, 1e-7, "-1e-7", "-12.5", "+1", "=1", "+x", "-1e-7+1", "@x", "\tx", "\rx"];
  const sheet = tableSheet(
    [{ key: "value", title: "Value" }],
    values.map((value) => ({ value })),
    [],
    "raw",
  );
  const expected = [
    "Value",
    "-1e-7",
    "1e-7",
    "-1e-7",
    "-12.5",
    "+1",
    "'=1",
    "'+x",
    "'-1e-7+1",
    "'@x",
    "'\tx",
    "'\rx",
  ];
  for (const format of ["csv", "txt"]) {
    assertEquals(
      exportFile(format, sheet, "values", { bom: false, values: "raw" }).content,
      expected.map((value) => `"${value}"`).join("\n"),
    );
  }
  const excel = toExcel(sheet, "values");
  for (const value of expected.slice(1)) assertStringIncludes(excel, `<td>${value}</td>`);
});

test("JSON records keep sparse and missing cells as empty strings and explicit null as null", () => {
  const row: (string | null)[] = [];
  row[1] = null;
  assertEquals(JSON.parse(toJson({ headers: ["Sparse", "Null", "Missing"], rows: [row] })), [
    { Sparse: "", Null: null, Missing: "" },
  ]);
});

test("JSON as records by header, or the table export's shape", () => {
  assertEquals(JSON.parse(toJson(sheet))[1], { Name: "=HYPERLINK(1)", Total: -3.5, Code: "+1" });
  const table = JSON.parse(toJson(sheet, { json: "table" }));
  assertEquals(table.header, [{ 0: "Name", 1: "Total", 2: "Code" }]);
  assertEquals(table.data[1], { 0: "=HYPERLINK(1)", 1: "-3.5", 2: "+1" });
});

test("XML, SQL and the HTML .xls escape what they must", () => {
  assertStringIncludes(
    toXml(sheet),
    "<column-1>Ann &quot;the&quot; &lt;boss&gt; &amp; co</column-1>",
  );
  const sql = toSql({ headers: ["it's", "n"], rows: [["O'Brien \\ x", 2]] }, "my`table");
  assertEquals(sql, "INSERT INTO `my``table` (`it's`,`n`) VALUES ('O''Brien \\\\ x',2);");
  const xls = toExcel(sheet, "s");
  assertStringIncludes(xls, "<td>'=HYPERLINK(1)</td>");
  assertStringIncludes(xls, "&lt;boss&gt;");
});

test("PDF: starts as one, its cross-reference is right, a page per page of rows", () => {
  const many: Sheet = {
    headers: ["#", "Name"],
    rows: Array.from({ length: 70 }, (_, i) => [i + 1, `Row € “${i}” 日本`]),
  };
  const bytes = tablePdf(many, { title: "Rows", headerColor: "#0f766e" });
  const text = String.fromCharCode(...bytes);
  assert(text.startsWith("%PDF-1.4\n"));
  assert(text.trimEnd().endsWith("%%EOF"));
  const start = Number(text.match(/startxref\n(\d+)/)![1]);
  assertEquals(text.slice(start, start + 4), "xref");
  const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  offsets.forEach((offset, i) =>
    assertEquals(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`)
  );
  const pages = Number(text.match(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/)![1]);
  assertEquals(pages, 3);
  assertEquals((text.match(/\/Type \/Page /g) ?? []).length, 3);
  assertStringIncludes(text, "0.059 0.463 0.431 rg");
  // WinAnsi: € and curly quotes kept as its bytes, what it lacks as "?".
  assertEquals(winAnsi("€ “x” 日"), "\x80 \x93x\x94 ?");
  // A table with no rows is one page with its header.
  const empty = String.fromCharCode(...tablePdf({ headers: ["A"], rows: [] }));
  assertStringIncludes(empty, "/Count 1");
});

test("a file per format: its name, type, and CSV's byte-order mark", () => {
  const csv = exportFile("csv", sheet, "sales");
  assertEquals([csv.file, csv.type], ["sales.csv", "text/csv;charset=utf-8"]);
  assert((csv.content as string).startsWith('﻿"Name"'));
  assert(!(exportFile("csv", sheet, "s", { bom: false }).content as string).startsWith("﻿"));
  assertEquals(exportFile("xlsx", sheet, "s").file, "s.xlsx");
  assertEquals(exportFile("excel", sheet, "s").file, "s.xls");
  assert(exportFile("pdf", sheet, "s").content instanceof Uint8Array);
  assertEquals(exportFile("sql", sheet, "s").type, "application/sql");
});

test("CSV dialect quotes only what needs it and keeps the formula guard", () => {
  const input = {
    headers: ["First", "Second"],
    rows: [["=1", 'quote"'], ["a;b", "a\nb"]],
    footerRows: [["Total", 7]],
  };
  assertEquals(
    toCsv(input, {
      csv: {
        quote: "needed",
        delimiter: ";",
        header: false,
        lineEnding: "\r\n",
        finalNewline: true,
      },
    }),
    '\'=1;"quote"""\r\n"a;b";"a\nb"\r\nTotal;7\r\n',
  );
  assertEquals(
    toCsv({ headers: ["A"], rows: [] }, { csv: { header: false, finalNewline: true } }),
    "",
  );
  assertEquals(
    toCsv(input, { csv: { delimiter: "\t", lineEnding: "\r" } }).split("\r")[0],
    '"First"\t"Second"',
  );
  assertThrows(() => toCsv(input, { csv: { delimiter: "" } }));
});

test("custom serializers get the projected sheet, totals, base name and options", () => {
  const data = [{ price: 2.5, paid: false, note: null }];
  const columns = [
    {
      key: "price",
      title: "Price",
      text: (r: typeof data[number]) => "$" + r.price.toFixed(2),
    },
    { key: "paid", title: "Paid" },
    { key: "note", title: "Note" },
    { key: "edit", title: "" },
  ];
  const totals = [{ price: 2.5 }];
  const shown = tableSheet(columns, data, totals);
  assertEquals(shown.rows, [["$2.50", "false", ""]]);
  assertEquals(shown.keys, ["price", "paid", "note"]);
  const raw = tableSheet(columns, data, totals, "raw");
  assertEquals(raw.rows, [[2.5, false, null]]);
  assertEquals(raw.footerRows, [[2.5, "", ""]]);
  const custom = exportFile("csv", raw, "invoices", {
    formats: {
      csv: {
        label: "Binary",
        type: "application/octet-stream",
        extension: "bin",
        serialize(sheet, name) {
          assertEquals(sheet, raw);
          assertEquals(name, "invoices");
          return Uint8Array.of(4, 2);
        },
      },
    },
  });
  assertEquals(custom, {
    file: "invoices.bin",
    type: "application/octet-stream",
    content: Uint8Array.of(4, 2),
  });
  const sql = exportFile("sql", raw, "invoices", { tableName: "invoice_lines" });
  assertEquals(sql.file, "invoices.sql");
  assertStringIncludes(
    String(sql.content),
    "INSERT INTO `invoice_lines` (`Price`,`Paid`,`Note`) VALUES (2.5,FALSE,NULL);",
  );
  assertEquals(JSON.parse(toJson(raw))[0], { Price: 2.5, Paid: false, Note: null });
  assertEquals(JSON.parse(toJson(raw, { json: "table", values: "raw" })).data[0], {
    0: 2.5,
    1: false,
    2: null,
  });
  assertThrows(() => exportFile("toString", raw, "orders"), RangeError);
});

test("all eight built-in formats include the supplied totals", () => {
  const sheet = {
    headers: ["Product", "Price"],
    rows: [["Pen", 2]],
    footerRows: [["Grand Total", 2]],
  };
  for (const format of ["csv", "txt", "xlsx", "excel", "sql", "pdf", "json", "xml"]) {
    const { content } = exportFile(format, sheet, "products");
    const text = typeof content === "string" ? content : new TextDecoder().decode(content);
    assertStringIncludes(text, "Grand Total");
  }
  assertEquals(JSON.parse(toJson(sheet, { json: "table" })).data.at(-1), {
    0: "Grand Total",
    1: "2",
  });
});

test("a table PDF repeats headings, lays out its logo and titles, and aligns its totals", async () => {
  const image = await pdfImage(await barcodePng("ORDER"));
  const sheet = {
    headers: ["Order", "Amount"],
    rows: Array.from({ length: 4 }, (_, i) => [i, 10]),
    footerRows: [["Total", 40]],
  };
  const file = String.fromCharCode(
    ...tablePdf(sheet, {
      size: [300, 200],
      fontSize: 10,
      title: ["Orders", "November"],
      subtitle: "Paid invoices",
      headerImage: { image, width: 40, height: 16 },
      columns: [{ width: 130 }, { align: "right" }],
    }),
  );
  assertStringIncludes(file, "/MediaBox [0 0 300 200]");
  assertStringIncludes(file, "/Count 2");
  for (const line of ["Orders", "November", "Paid invoices", "Total"]) {
    assertEquals(file.split("(" + line + ") Tj").length, 2);
  }
  assertEquals(file.split("(Amount) Tj").length, 3);
  assertStringIncludes(file, "q 40 0 0 16 36 148 cm /Im1 Do Q");
  const x = Number(file.match(/Tf ([\d.]+) [\d.]+ Td \(40\) Tj/)![1]);
  assertEquals(x, 249.88); // right edge 264, minus padding 3 and Helvetica Bold's 11.12 points
  const letter = String.fromCharCode(
    ...tablePdf(sheet, { size: "letter", orientation: "portrait" }),
  );
  assertStringIncludes(letter, "/MediaBox [0 0 612 792]");
  assertThrows(() => tablePdf(sheet, { size: [100, 150], columns: [{ width: 90 }] }));
});

test("an Action makes invoice attachments through the server export entry point", async () => {
  const { createRuntime, definePlugin } = await import("../../../runtime/mod.ts");
  const { memoryStore } = await import("../../../stores/memory/mod.ts");
  const { exportFile } = await import("../export.ts");
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [definePlugin({
      name: "invoices",
      actions: {
        "invoice.attachments": {
          run() {
            const sheet = { headers: ["Order"], rows: [["Order 12"]] };
            const pdf = exportFile("pdf", sheet, "invoice");
            const csv = exportFile("csv", sheet, "orders");
            return {
              type: pdf.type,
              pdfHeader: new TextDecoder().decode((pdf.content as Uint8Array).subarray(0, 8)),
              csv: csv.content,
            };
          },
        },
      },
    })],
  });
  try {
    assertEquals(await runtime.call("invoice.attachments", {}), {
      type: "application/pdf",
      pdfHeader: "%PDF-1.4",
      csv: '﻿"Order"\n"Order 12"',
    });
  } finally {
    await runtime.close();
  }
});

test("minimal CSV quotes preserve a single empty field as a record", () => {
  assertEquals(
    toCsv({ headers: ["Value"], rows: [[""]] }, { csv: { quote: "needed" } }),
    'Value\n""',
  );
  assertEquals(
    toCsv({ headers: ["A", "B"], rows: [["", ""]] }, { csv: { quote: "needed" } }),
    "A,B\n,",
  );
});
