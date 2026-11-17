/**
 * A table as a file: CSV, Excel (`.xlsx`, a real workbook; or `.xls`, the
 * HTML table older tools write), PDF, JSON, XML, plain text or SQL inserts,
 * made where it runs (the browser, or a server: no dependency) from a
 * `Sheet`: the headers and each row's cells. `exportFile` gives the file's
 * name, type and content; `download` saves it in the browser.
 *
 * - **CSV and text** quote every cell. A cell that starts as a formula would
 *   (`=`, `+`, `-`, `@`) gets a `'` before it, so a spreadsheet never runs
 *   what someone typed (OWASP's CSV injection); a plain number (`-12.5`)
 *   stays as it is. `{ formulas: true }` turns that off. The file starts
 *   with a byte-order mark, so Excel reads its accents (`{ bom: false }`:
 *   none).
 * - **`.xlsx`** writes a number as a number (`12`, `-3.5`; not `007`, which
 *   stays text), everything else as text, never as a formula.
 * - **JSON** is the rows as objects by header (`[{ "Name": "Ann" }]`), or
 *   the table export's shape that tools such as bootstrap-table's write
 *   (`{ json: "table" }`: `{ header: [{ "0": … }], data: [{ "0": … }] }`).
 * - **PDF** is Helvetica, A4 landscape (see `pdf.ts`).
 *
 * ```ts
 * download("xlsx", { headers: ["Name", "Total"], rows: [["Ann", 12.5]] }, "sales");
 * ```
 */
import { type PdfOptions, tablePdf } from "./pdf.ts";
import { zip } from "./zip.ts";

/** The formats a table exports to. */
export type ExportFormat = "csv" | "xlsx" | "excel" | "pdf" | "json" | "xml" | "txt" | "sql";

/** A table as cells: its headers and its rows (text, or numbers). */
export type Sheet = { headers: string[]; rows: (string | number)[][] };

/** How the files are made. */
export type ExportOptions = {
  /** CSV, text and `.xls`: let cells start as formulas (`=SUM(…)`), unguarded. */
  formulas?: boolean;
  /** CSV and text: a byte-order mark first (yes, by default). */
  bom?: boolean;
  /** JSON's shape: rows as objects by header (the default), or the table export's. */
  json?: "records" | "table";
  /** The PDF's title and colours. */
  pdf?: PdfOptions;
};

/** Each format's name in an export menu, in the order a menu lists them. */
export const EXPORT_FORMATS: { format: ExportFormat; label: string }[] = [
  { format: "csv", label: "CSV" },
  { format: "xlsx", label: "Excel" },
  { format: "pdf", label: "PDF" },
  { format: "json", label: "JSON" },
  { format: "xml", label: "XML" },
  { format: "txt", label: "TXT" },
  { format: "sql", label: "SQL" },
  { format: "excel", label: "MS-Excel" },
];

const TYPES: Record<ExportFormat, [extension: string, type: string]> = {
  csv: ["csv", "text/csv;charset=utf-8"],
  xlsx: ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  excel: ["xls", "application/vnd.ms-excel"],
  pdf: ["pdf", "application/pdf"],
  json: ["json", "application/json"],
  xml: ["xml", "application/xml"],
  txt: ["txt", "text/plain;charset=utf-8"],
  sql: ["sql", "application/sql"],
};

const text = (cell: string | number | undefined) => cell === undefined ? "" : String(cell);

/** A plain number, as `.xlsx` writes as one: no leading zeros (an id such as `007` is text). */
const NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d+)?$/;

/** A cell a spreadsheet would read as a formula, made plain text with a leading `'`. */
export function guard(cell: string): string {
  if (NUMBER.test(cell)) return cell;
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

/** XML's control characters (all but tab, newline and return): XML can't hold them. */
const controls = (value: string) =>
  [...value].filter((c) => {
    const code = c.charCodeAt(0);
    return code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  }).join("");

const markup = (value: string) =>
  controls(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** CSV: every cell quoted, rows on lines. */
export function toCsv({ headers, rows }: Sheet, { formulas }: ExportOptions = {}): string {
  const cell = (value: string | number | undefined) => {
    const plain = text(value);
    return `"${(formulas ? plain : guard(plain)).replace(/"/g, '""')}"`;
  };
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\n");
}

/** JSON: the rows as objects by header, or the table export's shape. */
export function toJson({ headers, rows }: Sheet, { json = "records" }: ExportOptions = {}): string {
  if (json === "table") {
    const byIndex = (cells: (string | number)[]) =>
      Object.fromEntries(cells.map((cell, i) => [String(i), text(cell)]));
    return JSON.stringify({ header: [byIndex(headers)], data: rows.map(byIndex) });
  }
  return JSON.stringify(
    rows.map((row) => Object.fromEntries(headers.map((header, i) => [header, row[i] ?? ""]))),
  );
}

/** XML: the fields, then each row's columns by position. */
export function toXml({ headers, rows }: Sheet): string {
  const fields = headers.map((h) => `<field>${markup(h)}</field>`).join("");
  const data = rows.map((row, i) =>
    `<row id="${i + 1}">${
      row.map((cell, j) => `<column-${j + 1}>${markup(text(cell))}</column-${j + 1}>`).join("")
    }</row>`
  ).join("");
  return `<?xml version="1.0" encoding="utf-8"?><tabledata><fields>${fields}</fields><data>${data}</data></tabledata>`;
}

/** SQL: an insert into `table` per row. */
export function toSql({ headers, rows }: Sheet, table: string): string {
  const name = (id: string) => `\`${id.replace(/`/g, "``")}\``;
  const value = (cell: string | number | undefined) =>
    typeof cell === "number" && Number.isFinite(cell)
      ? String(cell)
      : `'${text(cell).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  const columns = headers.map(name).join(",");
  return rows.map((row) =>
    `INSERT INTO ${name(table)} (${columns}) VALUES (${
      headers.map((_, i) => value(row[i])).join(",")
    });`
  ).join("\n");
}

/** `.xls`: the HTML table Excel opens (it warns that the file isn't a workbook). */
export function toExcel(
  { headers, rows }: Sheet,
  name: string,
  options: ExportOptions = {},
): string {
  const cell = (value: string | number | undefined) =>
    markup(options.formulas ? text(value) : guard(text(value)));
  const tr = (cells: (string | number)[], tag: string) =>
    `<tr>${cells.map((c) => `<${tag}>${cell(c)}</${tag}>`).join("")}</tr>`;
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">` +
    `<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>${
      markup(name)
    }</x:Name>` +
    `<x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>` +
    `<body><table><thead>${tr(headers, "th")}</thead><tbody>${
      rows.map((row) => tr(row, "td")).join("")
    }</tbody></table></body></html>`;
}

/** A column's letters: 0 is A, 26 is AA. */
const column = (index: number): string =>
  index < 26
    ? String.fromCharCode(65 + index)
    : column(Math.floor(index / 26) - 1) + column(index % 26);

/** `.xlsx`: a workbook of one sheet, named `name`, its header row bold. */
export function toXlsx({ headers, rows }: Sheet, name: string): Uint8Array {
  const sheetName = markup(name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1");
  const cell = (value: string | number | undefined, ref: string, style: string) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${ref}"${style}><v>${value}</v></c>`;
    }
    const plain = text(value);
    if (NUMBER.test(plain)) return `<c r="${ref}"${style}><v>${plain}</v></c>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${
      markup(plain)
    }</t></is></c>`;
  };
  const row = (cells: (string | number)[], r: number, style: string) =>
    `<row r="${r}">${cells.map((c, i) => cell(c, `${column(i)}${r}`, style)).join("")}</row>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    [row(headers, 1, ' s="1"'), ...rows.map((r, i) => row(r, i + 2, ""))].join("")
  }</sheetData></worksheet>`;
  const MAIN = "http://schemas.openxmlformats.org";
  return zip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="${MAIN}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${MAIN}/package/2006/relationships"><Relationship Id="rId1" Type="${MAIN}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${MAIN}/spreadsheetml/2006/main" xmlns:r="${MAIN}/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${MAIN}/package/2006/relationships"><Relationship Id="rId1" Type="${MAIN}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${MAIN}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      name: "xl/styles.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN}/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    },
    { name: "xl/worksheets/sheet1.xml", content: sheet },
  ]);
}

/** A PDF of the table (see `pdf.ts`). */
export const toPdf = (sheet: Sheet, options?: PdfOptions): Uint8Array => tablePdf(sheet, options);

/** The file for one format: its name (`<name>.<extension>`), its type and its content. */
export function exportFile(
  format: ExportFormat,
  sheet: Sheet,
  name: string,
  options: ExportOptions = {},
): { file: string; type: string; content: string | Uint8Array } {
  const [extension, type] = TYPES[format];
  const bom = options.bom === false ? "" : "﻿";
  const content = format === "csv" || format === "txt"
    ? bom + toCsv(sheet, options)
    : format === "xlsx"
    ? toXlsx(sheet, name)
    : format === "excel"
    ? toExcel(sheet, name, options)
    : format === "pdf"
    ? toPdf(sheet, options.pdf)
    : format === "json"
    ? toJson(sheet, options)
    : format === "xml"
    ? toXml(sheet)
    : toSql(sheet, name);
  return { file: `${name}.${extension}`, type, content };
}

/** Saves the file in the browser, as a download. */
export function download(
  format: ExportFormat,
  sheet: Sheet,
  name: string,
  options?: ExportOptions,
): void {
  const { file, type, content } = exportFile(format, sheet, name, options);
  const url = URL.createObjectURL(new Blob([content as BlobPart], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
