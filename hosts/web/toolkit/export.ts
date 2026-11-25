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
 * - **`.xlsx`** writes finite numbers and booleans as typed cells. Display
 *   strings such as `"12"` and `"-3.5"` become numeric cells, while
 *   `"007"` stays text. With raw values every string stays text.
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

/** A scalar cell in a file. Raw exports keep numbers, booleans and null. */
export type ExportCell = string | number | boolean | null;

/** The visible headers, body and optional totals. A table also supplies the matching column keys. */
export type Sheet<Cell extends ExportCell = string | number> = {
  headers: string[];
  keys?: string[];
  rows: Cell[][];
  footerRows?: Cell[][];
};

/** Add one of these to formats, keyed by its name, to offer a file anywhere a table is exported. */
export type TableExportFormat = {
  label: string;
  extension: string;
  type: string;
  serialize(sheet: Sheet<ExportCell>, name: string, options: ExportOptions): string | Uint8Array;
};

/** How the files are made. */
export type ExportOptions = {
  /** CSV, text and `.xls`: let cells start as formulas (`=SUM(…)`), unguarded. */
  formulas?: boolean;
  /** CSV and text: a byte-order mark first (yes, by default). */
  bom?: boolean;
  /** JSON's shape: rows as objects by header (the default), or the table export's. */
  json?: "records" | "table";
  /** CSV and text delimiters, quoting and line endings. Defaults preserve the quoted CSV format. */
  csv?: {
    quote?: "always" | "needed";
    delimiter?: string;
    lineEnding?: "\n" | "\r\n" | "\r";
    finalNewline?: boolean;
    header?: boolean;
  };
  /** The SQL INSERT target, the file's base name by default. */
  tableName?: string;
  /** A table uses its column text by default. Raw uses the field at each column key. */
  values?: "display" | "raw";
  /** Add or replace named formats for this export. */
  formats?: Record<string, TableExportFormat>;
  /** The PDF's page layout, title, logo and colours. */
  pdf?: PdfOptions;
};

function dataRows({ rows, footerRows }: Sheet<ExportCell>) {
  return footerRows?.length ? [...rows, ...footerRows] : rows;
}

const text = (cell: ExportCell | undefined) => cell == null ? "" : String(cell);

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

/** CSV, quoted and formula-guarded by default. Set csv to match a file's dialect. */
export function toCsv(
  sheet: Sheet<ExportCell>,
  { formulas, csv = {} }: ExportOptions = {},
): string {
  const { delimiter = ",", lineEnding = "\n", quote = "always" } = csv;
  if ([...delimiter].length !== 1 || /["\r\n]/.test(delimiter)) {
    throw new RangeError("Invalid CSV delimiter.");
  }
  const cell = (value: ExportCell) => {
    const plain = formulas ? text(value) : guard(text(value));
    if (quote === "needed" && !plain.includes(delimiter) && !/["\r\n]/.test(plain)) return plain;
    return `"${plain.replace(/"/g, '""')}"`;
  };
  const rows = dataRows(sheet);
  const lines = (csv.header === false ? rows : [sheet.headers, ...rows]).map((r) =>
    r.length === 1 && text(r[0]) === "" ? '""' : r.map(cell).join(delimiter)
  );
  return lines.join(lineEnding) + (lines.length && csv.finalNewline ? lineEnding : "");
}

/** JSON: the rows as objects by header, or the table export's shape. */
export function toJson(
  sheet: Sheet<ExportCell>,
  { json = "records", values }: ExportOptions = {},
): string {
  const { headers } = sheet;
  const rows = dataRows(sheet);
  if (json === "table") {
    const byIndex = (cells: ExportCell[]) =>
      Object.fromEntries(cells.map((cell, i) => [String(i), values === "raw" ? cell : text(cell)]));
    return JSON.stringify({ header: [byIndex(headers)], data: rows.map(byIndex) });
  }
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(headers.map((header, i) => [header, row[i] === undefined ? "" : row[i]]))
    ),
  );
}

/** XML: the fields, then each row's columns by position. */
export function toXml(sheet: Sheet<ExportCell>): string {
  const { headers } = sheet;
  const rows = dataRows(sheet);
  const fields = headers.map((h) => `<field>${markup(h)}</field>`).join("");
  const data = rows.map((row, i) =>
    `<row id="${i + 1}">${
      row.map((cell, j) => `<column-${j + 1}>${markup(text(cell))}</column-${j + 1}>`).join("")
    }</row>`
  ).join("");
  return `<?xml version="1.0" encoding="utf-8"?><tabledata><fields>${fields}</fields><data>${data}</data></tabledata>`;
}

/** SQL: an insert into `table` per row. */
export function toSql(sheet: Sheet<ExportCell>, table: string): string {
  const { headers } = sheet;
  const rows = dataRows(sheet);
  const name = (id: string) => `\`${id.replace(/`/g, "``")}\``;
  const value = (cell: ExportCell | undefined) =>
    cell === null
      ? "NULL"
      : typeof cell === "boolean"
      ? (cell ? "TRUE" : "FALSE")
      : typeof cell === "number" && Number.isFinite(cell)
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
  sheet: Sheet<ExportCell>,
  name: string,
  options: ExportOptions = {},
): string {
  const { headers } = sheet;
  const rows = dataRows(sheet);
  const cell = (value: ExportCell | undefined) =>
    markup(options.formulas ? text(value) : guard(text(value)));
  const tr = (cells: ExportCell[], tag: string) =>
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
export function toXlsx(
  input: Sheet<ExportCell>,
  name: string,
  { values }: ExportOptions = {},
): Uint8Array {
  const { headers } = input;
  const rows = dataRows(input);
  const sheetName = markup(name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1");
  const cell = (value: ExportCell | undefined, ref: string, style: string) => {
    if (typeof value === "boolean") {
      return `<c r="${ref}"${style} t="b"><v>${Number(value)}</v></c>`;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `<c r="${ref}"${style}><v>${value}</v></c>`;
    }
    const plain = text(value);
    if (values !== "raw" && NUMBER.test(plain)) return `<c r="${ref}"${style}><v>${plain}</v></c>`;
    return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${
      markup(plain)
    }</t></is></c>`;
  };
  const row = (cells: ExportCell[], r: number, style: string) =>
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
export const toPdf = (sheet: Sheet<ExportCell>, options?: PdfOptions): Uint8Array =>
  tablePdf(sheet, options);

const csvFile: TableExportFormat["serialize"] = (sheet, _name, options) =>
  (options.bom === false ? "" : "﻿") + toCsv(sheet, options);

const builtins: Record<ExportFormat, TableExportFormat> = {
  csv: { label: "CSV", extension: "csv", type: "text/csv;charset=utf-8", serialize: csvFile },
  xlsx: {
    label: "Excel",
    extension: "xlsx",
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    serialize: toXlsx,
  },
  pdf: {
    label: "PDF",
    extension: "pdf",
    type: "application/pdf",
    serialize: (sheet, _name, options) => toPdf(sheet, options.pdf),
  },
  json: {
    label: "JSON",
    extension: "json",
    type: "application/json",
    serialize: (sheet, _name, options) => toJson(sheet, options),
  },
  xml: { label: "XML", extension: "xml", type: "application/xml", serialize: toXml },
  txt: { label: "TXT", extension: "txt", type: "text/plain;charset=utf-8", serialize: csvFile },
  sql: {
    label: "SQL",
    extension: "sql",
    type: "application/sql",
    serialize: (sheet, name, options) => toSql(sheet, options.tableName ?? name),
  },
  excel: {
    label: "MS-Excel",
    extension: "xls",
    type: "application/vnd.ms-excel",
    serialize: toExcel,
  },
};

/** The built-in formats and their labels, in menu order. */
export const EXPORT_FORMATS: { format: ExportFormat; label: string }[] =
  (Object.keys(builtins) as ExportFormat[]).map((format) => ({
    format,
    label: builtins[format].label,
  }));

/** Makes a named file in a browser or an Action, using a custom serializer when formats supplies one. */
export function exportFile(
  format: string,
  sheet: Sheet<ExportCell>,
  name: string,
  options: ExportOptions = {},
): { file: string; type: string; content: string | Uint8Array } {
  const custom = options.formats;
  const def = custom && Object.hasOwn(custom, format)
    ? custom[format]
    : Object.hasOwn(builtins, format)
    ? builtins[format as ExportFormat]
    : undefined;
  if (!def) throw new RangeError(`Unknown table export format: ${format}`);
  return {
    file: `${name}.${def.extension}`,
    type: def.type,
    content: def.serialize(sheet, name, options),
  };
}

/** Saves the file in the browser, as a download. */
export function download(
  format: string,
  sheet: Sheet<ExportCell>,
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
