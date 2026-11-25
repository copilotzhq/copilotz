/**
 * The web toolkit's files, without React or a page: on a server too. A table
 * as CSV, a workbook (`.xlsx`), a PDF, JSON, XML, TXT or SQL (`exportFile`);
 * a document drawn as a PDF (`documentPdf`: a receipt, an invoice); and Code
 * 128's bars (`bars`), for an e-mailed invoice or a receipt made where no
 * browser is. In a page, `copilotz/web` has the same, and `download` saves a
 * file.
 *
 * ```ts
 * import { documentPdf, exportFile } from "copilotz/web/export";
 * const { file, type, content } = exportFile("xlsx", { headers: ["Item", "Price"], rows: [["Café", 4.5]] }, "items");
 * ```
 */
export {
  EXPORT_FORMATS,
  exportFile,
  type ExportFormat,
  type ExportOptions,
  type Sheet,
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
  type Drawn,
  type PageSize,
  type PdfFont,
  type PdfOptions,
  tablePdf,
  textWidth,
  wrapText,
} from "./toolkit/pdf.ts";
export { barcodePng } from "./toolkit/barcode-png.ts";
export { code39, ean13, ean8, eanDigits } from "./toolkit/retail-barcodes.ts";
export { type PdfImage, pdfImage } from "./toolkit/pdf-image.ts";
export { type BarcodeOptions, bars, code128 } from "./toolkit/code128.ts";
