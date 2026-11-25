/** Strict consumer fixture shared with rc.63 (2383779c). */
import type { DataTable, ExportChoice } from "../mod.ts";
import type { documentPdf, Drawn, ExportFormat, PdfOptions } from "../export.ts";

export function formatOf(choice: ExportChoice): ExportFormat {
  if (typeof choice === "string") return choice;
  return choice.format;
}

export function titleOf(options: PdfOptions): string {
  return options.title?.trim() ?? "";
}

export function forwardPages(pages: Parameters<typeof documentPdf>[0]): Drawn[][] {
  return pages;
}

export function showsToolbar(props: Parameters<typeof DataTable>[0]): boolean {
  return props.toolbar ?? true;
}
