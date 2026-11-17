/**
 * A document as a PDF, made on a server: its file's structure, its pages
 * and their sizes (a receipt as long as what's on it), text set by
 * Helvetica's widths (wrapped, centred, right), escaped and in WinAnsi,
 * lines and boxes, and a barcode's bars.
 */
import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { bars } from "../toolkit/code128.ts";
import { documentPdf, tablePdf, textWidth, wrapText } from "../toolkit/pdf.ts";

const text = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** Every object the cross-reference names starts where it says. */
function wellMade(file: string): void {
  assert(file.startsWith("%PDF-1.4\n"));
  assert(file.trimEnd().endsWith("%%EOF"));
  const start = Number(file.match(/startxref\n(\d+)/)![1]);
  assertEquals(file.slice(start, start + 4), "xref");
  const offsets = [...file.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert(offsets.length > 0);
  offsets.forEach((offset, i) =>
    assertEquals(file.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`)
  );
  // Each stream is as long as it says.
  for (
    const [, length, body] of file.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)
  ) {
    assertEquals(body.length, Number(length));
  }
}

test("Helvetica's widths: measured as it sets them, accents as their letters", () => {
  assertAlmostEquals(textWidth("Hello", 10), 22.78, 0.01); // H 722, e 556, l 222, l 222, o 556
  assertAlmostEquals(textWidth("Hello", 10, "bold"), 24.45, 0.01); // H 722, e 556, l 278, l 278, o 611
  assertEquals(textWidth("João", 10), textWidth("Joao", 10));
  assertEquals(textWidth("Ç"), textWidth("C"));
  assertEquals(textWidth(""), 0);
});

test("text wraps between words, breaks a word longer than the line, keeps its own breaks", () => {
  const lines = wrapText("one two three four five six", 50, 10);
  assert(lines.length > 1);
  for (const line of lines) assert(textWidth(line, 10) <= 50);
  assertEquals(lines.join(" "), "one two three four five six");
  const long = wrapText("abcdefghijklmnopqrstuvwxyz", 40, 10);
  assert(long.length > 1);
  assertEquals(long.join(""), "abcdefghijklmnopqrstuvwxyz");
  assertEquals(wrapText("a\nb", 100), ["a", "b"]);
});

test("a document: its pages, sizes, faces, text set and escaped, lines and boxes", () => {
  const file = text(documentPdf([
    [
      { text: "Total (R$)", x: 20, y: 20, size: 12, font: "bold" },
      { text: "€ “1” 日", x: 20, y: 40, width: 200, align: "right", color: "#0f766e" },
      { line: [20, 60, 220, 60], thickness: 1 },
      { rect: [20, 70, 100, 20], fill: "#eeeeee", stroke: "#000000" },
    ],
    [{ text: "Page two", x: 20, y: 20, font: "italic" }],
  ]));
  wellMade(file);
  assertStringIncludes(file, "/Count 2");
  assertEquals((file.match(/\/MediaBox \[0 0 595 842\]/g) ?? []).length, 2);
  // Only the faces used, each named in the pages' resources.
  assertStringIncludes(file, "/BaseFont /Helvetica-Bold");
  assertStringIncludes(file, "/BaseFont /Helvetica-Oblique");
  assertStringIncludes(file, "/BaseFont /Helvetica ");
  assert(!file.includes("Helvetica-BoldOblique"));
  assertStringIncludes(file, "/Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>");
  // A bracket escaped; WinAnsi's €, curly quotes, and "?" for what it lacks.
  assertStringIncludes(file, "(Total \\(R$\\)) Tj");
  assertStringIncludes(file, "(\x80 \x931\x94 ?) Tj");
  assertStringIncludes(file, "0.059 0.463 0.431 rg");
  // Right-set: it ends at the width's end.
  const x = Number(file.match(/Tf ([\d.]+) [\d.]+ Td \(\x80/)![1]);
  assertAlmostEquals(x + textWidth("€ “1” ?", 10), 220, 0.02);
  // From the top: 842 - 60 for the line's y.
  assertStringIncludes(file, "1 w 20 782 m 220 782 l S");
  assertStringIncludes(file, "0.933 0.933 0.933 rg 0.000 0.000 0.000 RG 0.75 w 20 752 100 20 re B");
});

test("a receipt: 80 mm wide, as long as what's on it, and its barcode's bars", () => {
  const file = text(documentPdf([[
    { text: "Acme", x: 12, y: 12, width: 203, align: "center" },
    { barcode: "POS 12", x: 12, y: 40, width: 200, height: 40 },
  ]], { size: "receipt" }));
  wellMade(file);
  // The barcode's bottom (40 + 40) and the margin under it (12).
  assertStringIncludes(file, "/MediaBox [0 0 227 92]");
  const drawn = bars("POS 12", 200);
  const boxes = file.match(/ re f/g) ?? [];
  assertEquals(boxes.length, drawn.bars.length);
  assertStringIncludes(file, `${12 + drawn.bars[0].x} 12 ${drawn.bars[0].w} 40 re f`);
});

test("no pages is one blank page; the table PDF keeps its own two faces", () => {
  const blank = text(documentPdf([]));
  wellMade(blank);
  assertStringIncludes(blank, "/Count 1");
  const table = text(tablePdf({ headers: ["A", "B"], rows: [["1", "2"]] }));
  wellMade(table);
  assertStringIncludes(table, "/Font << /F1 3 0 R /F2 4 0 R >>");
});
