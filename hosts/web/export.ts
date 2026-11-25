/**
 * The web toolkit's files, without React or a page: on a server too. A table
 * as CSV, a workbook (`.xlsx`), a PDF, JSON, XML, TXT or SQL (`exportFile`);
 * a document with a logo (`pdfImage`) drawn as a PDF (`drawDocumentPdf`); and
 * Code 128, Code 39 and EAN barcodes as vector bars or PNG bytes. In a page, `copilotz/web` has the same, and `download` saves a
 * file.
 *
 * ```ts
 * import { documentPdf, exportFile } from "copilotz/web/export";
 * const { file, type, content } = exportFile("xlsx", { headers: ["Item", "Price"], rows: [["Café", 4.5]] }, "items");
 * ```
 */
export {
  EXPORT_FORMATS,
  type ExportCell,
  exportFile,
  type ExportFormat,
  type ExportOptions,
  exportTableFile,
  type Sheet,
  type TableExportFormat,
  type TableExportOptions,
  type TableExportSheet,
  toCsv,
  toExcel,
  toJson,
  toPdf,
  toSql,
  toXlsx,
  toXml,
} from "./toolkit/export.ts";
export {
  documentPdf,
  drawDocumentPdf,
  type Drawn,
  type PageSize,
  type PdfFont,
  type PdfOptions,
  tablePdf,
  type TablePdfOptions,
  textWidth,
  wrapText,
} from "./toolkit/pdf.ts";
export { barcodePng } from "./toolkit/barcode-png.ts";
export { code39, ean13, ean8, eanDigits } from "./toolkit/retail-barcodes.ts";
export { type PdfImage, pdfImage } from "./toolkit/pdf-image.ts";
export { barcodeBars, type BarcodeOptions, bars, code128 } from "./toolkit/code128.ts";

export { tableSheet } from "./toolkit/table-sheet.ts";
