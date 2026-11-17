/**
 * A table as a file, in every format, made with no library: CSV quotes its
 * cells and never lets one run as a formula; `.xlsx` is a real zip (its
 * structure and CRCs right) whose sheet has numbers as numbers and text
 * escaped; the PDF's cross-reference points at its objects and it has a
 * page per page of rows; JSON, XML, SQL and the HTML `.xls` escape what
 * they must.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

test("CSV quotes every cell and guards formulas, but not plain numbers", () => {
  assertEquals(guard("=1+1"), "'=1+1");
  assertEquals(guard("-12.5"), "-12.5");
  assertEquals(guard("-x"), "'-x");
  assertEquals(
    toCsv(sheet),
    [
      '"Name","Total","Code"',
      '"Ann ""the"" <boss> & co","12.50","007"',
      `"'=HYPERLINK(1)","-3.5","'+1"`,
      `"'@sum","-12.5","'-x"`,
    ].join("\n"),
  );
  assertStringIncludes(toCsv(sheet, { formulas: true }), '"=HYPERLINK(1)"');
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
