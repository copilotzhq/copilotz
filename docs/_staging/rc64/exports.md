# Table exports and documents

## CHANGELOG entry for New

- **Tables export an app's own formats.** Give `DataTable` a `formats` record or share it in the
  shell with `TableExportFormats`. A file takes the visible columns, their displayed or raw values,
  and `footerRows` of totals. CSV has quoting, separators, line endings and a header choice. SQL can
  name its own table. The toolbar takes the screen's buttons and filters, and the page-size menu can
  show a single size.
- **Printed tables, invoices and labels.** `tablePdf` takes a paper size, title and subtitle lines,
  logo, column widths and alignment. `pdfImage` prepares a PNG or JPEG for a table header or a
  `documentPdf` page, including a logo's transparency. Code 39 with optional Mod 43, EAN-8 and
  EAN-13 join Code 128 in `Barcode` and PDF vector bars. `barcodePng` makes the same bars as an
  image for an email. The file functions run in an Action as well as in a browser.

## Exact addition to AGENTS.md

In “A business app's web front end”, under “Short recipes”, insert after “A list with search,
filters, paging and exports”:

- **Custom table files and totals:** give `DataTable` `formats` (or the shell
  `<TableExportFormats value={formats}>`), `exportName` and `footerRows` by column key.
  `exportOptions` sets CSV's dialect, JSON's shape, SQL's `tableName`, `values: "raw"` and the PDF
  layout. Give `toolbar` a button or filter; `showSinglePageSize` keeps a lone size visible.
  [Exporting a table](https://copilotz.com/docs/guides/the-web-toolkit.md#exporting-a-table).
- **Invoices and product labels:** in an Action, `copilotz/web/export` has `exportFile` and
  `tablePdf` for a report with totals. Prepare a logo with `await pdfImage(bytesOrDataUrl)` for its
  header or a `documentPdf` page. Draw Code 128, Code 39 or EAN-8/13 with `Barcode` on screen,
  `{ barcode, format, x, y, width, height }` in a PDF and `await barcodePng(value, options)` for an
  image.
  [Images and barcodes in a document](https://copilotz.com/docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document).

## Capability index

```text
export a table to CSV/JSON/SQL/PDF with totals → DataTable exportOptions/formats/footerRows → docs/guides/the-web-toolkit.md#exporting-a-table
share a custom file format across screens → TableExportFormats → docs/guides/the-web-toolkit.md#exporting-a-table
put New or Print beside the table controls → DataTable toolbar → docs/guides/the-web-toolkit.md#a-toolbar-of-your-own
show a page-size menu with one choice → DataTable/Pagination showSinglePageSize → docs/guides/the-web-toolkit.md#a-toolbar-of-your-own
print or email a table with aligned totals and a logo → tablePdf → docs/guides/the-web-toolkit.md#printing-a-table
place a transparent PNG or a JPEG on an invoice → pdfImage/documentPdf → docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document
print a barcode on paper or screen → documentPdf/Barcode/bars → docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document
make a barcode PNG for a product label or email → barcodePng → docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document
compute or verify a product's EAN check digit → eanDigits → docs/guides/the-web-toolkit.md#images-and-barcodes-in-a-document
```
