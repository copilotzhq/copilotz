/** An rc.63 consumer. Compile this file unchanged against either release with tsc --strict. */
import type { ComponentProps, ReactNode } from "react";
import type * as web from "../mod.ts";
import type * as files from "../export.ts";
export type * from "./rc63-export-types.ts";

type Format = "csv" | "xlsx" | "excel" | "pdf" | "json" | "xml" | "txt" | "sql";
type Choice = Format | { format: Format; label: string };
type Sheet = { headers: string[]; rows: (string | number)[][] };
type Pdf = {
  title?: string;
  orientation?: "landscape" | "portrait";
  headerColor?: string;
  headerText?: string;
  stripeColor?: string | null;
  fontSize?: number;
};
type Options = { formulas?: boolean; bom?: boolean; json?: "records" | "table"; pdf?: Pdf };
type FileArgs = [Format, Sheet, string, Options?];
type PdfArgs = [Sheet, Pdf?];

declare function save(...args: FileArgs): void;
declare function print(...args: PdfArgs): void;
export function saveAs(...args: Parameters<typeof files.exportFile>) {
  save(...args);
}
export function printAs(...args: Parameters<typeof web.toPdf>) {
  print(...args);
}
export function title(props: ComponentProps<typeof web.DataTable>): string {
  return props.exportOptions?.pdf?.title?.trim() ?? "";
}

// Metadata attached by the application before assigning to an rc.63 type.
const invoice = { headers: ["Amount"], rows: [[42]], footerRows: [{ Amount: 42 }], keys: 17 };
export const invoiceSheet: files.Sheet = invoice;
const settings = {
  bom: false,
  csv: "accounting",
  formats: 42,
  pdf: { title: "Invoice", columns: "net" },
};
export const invoiceOptions: files.ExportOptions = settings;
const label = { barcode: "SKU", width: 100, height: 30, x: 0, y: 0, format: 42, check: "paid" };
export const invoiceLabel: files.Drawn = label;

// Both directions catch changes to existing fields and new required members.
type Compatible<A, B> = [A, B] extends [B, A]
  ? Exclude<keyof B, keyof A> extends never ? true : false
  : false;
type Check<T extends true> = T;
export type FileContracts = [
  Check<Compatible<files.ExportFormat, Format>>,
  Check<Compatible<web.ExportChoice, Choice>>,
  Check<Compatible<files.Sheet, Sheet>>,
  Check<Compatible<keyof files.Sheet, keyof Sheet>>,
  Check<Compatible<keyof files.ExportOptions, keyof Options>>,
  Check<Compatible<keyof files.PdfOptions, keyof Pdf>>,
  Check<Compatible<keyof NonNullable<Parameters<typeof files.bars>[2]>, "set" | "quiet">>,
  Check<
    Compatible<
      keyof Extract<files.Drawn, { barcode: string }>,
      "barcode" | "x" | "y" | "width" | "height" | "set" | "quiet" | "color"
    >
  >,
  Check<Compatible<files.ExportOptions, Options>>,
  Check<Compatible<files.PdfOptions, Pdf>>,
  Check<Compatible<Parameters<typeof web.download>, FileArgs>>,
  Check<Compatible<Parameters<typeof files.exportFile>, FileArgs>>,
  Check<Compatible<Parameters<typeof files.toPdf>, PdfArgs>>,
  Check<Compatible<Parameters<typeof files.tablePdf>, PdfArgs>>,
  Check<Compatible<Parameters<typeof files.toCsv>, [Sheet, Options?]>>,
  Check<Compatible<Parameters<typeof files.toJson>, [Sheet, Options?]>>,
  Check<Compatible<Parameters<typeof files.toExcel>, [Sheet, string, Options?]>>,
  Check<Compatible<Parameters<typeof files.toXlsx>, [Sheet, string]>>,
  Check<Compatible<Parameters<typeof files.toSql>, [Sheet, string]>>,
  Check<Compatible<Parameters<typeof files.toXml>, [Sheet]>>,
];

type TableProps<R> = {
  columns: web.Column<R>[];
  rows: R[];
  rowKey(row: R): web.RowKey;
  label?: string;
  total?: number;
  state?: web.TableState;
  onState?(state: web.TableState): void;
  pageSize?: number;
  pageSizes?: number[] | false;
  selectable?: boolean;
  actions?(selected: web.RowKey[], clear: () => void): ReactNode;
  search?: boolean;
  chooseColumns?: boolean;
  exports?: Choice[] | false;
  exportName?: string;
  exportAll?: boolean;
  exportOptions?: Options;
  empty?: ReactNode;
  loading?: boolean;
  footer?: ReactNode;
  detail?(row: R): ReactNode;
  detailOpen?: boolean | ((row: R) => boolean);
  layout?: "auto" | "fixed";
  toolbar?: boolean;
  pagination?: boolean;
  id?: string;
  className?: string;
};
export type TableContract = Check<
  Compatible<ComponentProps<typeof web.DataTable>, TableProps<unknown>>
>;

// Generated from git show 2383779c:hosts/web/mod.ts.
export type {
  Align,
  AppBarItem,
  AutocompleteOption,
  Binding,
  Blanks,
  ButtonProps,
  CalendarValue,
  Client,
  ClientLink,
  Clock,
  CodePart,
  CodeTone,
  Column,
  Control,
  DateRange,
  DayFormat,
  DayTime,
  DayTimeFormat,
  Detail,
  DisplayMode,
  Drawing,
  Drawn,
  ExportChoice,
  ExportFormat,
  ExportOptions,
  IconButtonProps,
  IconLike,
  IconName,
  Justify,
  Known,
  ListGroupItem,
  MenuItem,
  MenuTrigger,
  PageSize,
  PaletteControl,
  PaletteDialog,
  PaletteGroup,
  PaletteItem,
  PaletteStep,
  PartAnswer,
  PartSubmit,
  PdfFont,
  PdfOptions,
  Phrase,
  PickerOption,
  Picture,
  PopoverTrigger,
  Preset,
  RailItemProps,
  RangePreset,
  RowKey,
  Say,
  Sheet,
  SignInAbout,
  SignInPage,
  SignInPoint,
  SignInWords,
  Space,
  Tab,
  TableState,
  TerminalOutput,
  TerminalSession,
  TextTone,
  Theme,
  Tile,
  ToastOptions,
  ToastPlacement,
  ToastTone,
  Tone,
  WebOptions,
  Where,
  Who,
  Widgets,
  Words,
} from "../mod.ts";
export type WebValues = Pick<
  typeof import("../mod.ts"),
  | "AppBar"
  | "AudioPlayer"
  | "Autocomplete"
  | "Avatar"
  | "Badge"
  | "Barcode"
  | "Button"
  | "COPILOTZ_ABOUT"
  | "Calendar"
  | "Card"
  | "Checkbox"
  | "Chip"
  | "CodeBlock"
  | "CopyButton"
  | "DEFAULT_THEME"
  | "DataTable"
  | "DatePicker"
  | "DateRangePicker"
  | "DateTimePicker"
  | "DetailList"
  | "DetailValue"
  | "Dialog"
  | "Divider"
  | "Drawer"
  | "EXPORT_FORMATS"
  | "EmptyState"
  | "Field"
  | "FileInput"
  | "Form"
  | "Grid"
  | "GridItem"
  | "Heading"
  | "ICONS"
  | "Icon"
  | "IconButton"
  | "InlineEdit"
  | "Input"
  | "Kbd"
  | "LazyView"
  | "ListGroup"
  | "LiveClock"
  | "Logo"
  | "LongText"
  | "Markdown"
  | "Menu"
  | "MultiPicker"
  | "NavItem"
  | "NoPrint"
  | "Notice"
  | "PAGE_SIZES"
  | "Page"
  | "Pagination"
  | "Palette"
  | "Part"
  | "Picker"
  | "Popover"
  | "PrintOnly"
  | "Radio"
  | "RailItem"
  | "ResizeHandle"
  | "RowsEditor"
  | "SIGN_IN_WORDS"
  | "STANDARD_PRESETS"
  | "Screen"
  | "Select"
  | "Skeleton"
  | "Spacer"
  | "Spinner"
  | "Split"
  | "Stack"
  | "Switch"
  | "Tabs"
  | "TagsInput"
  | "Terminal"
  | "Text"
  | "Textarea"
  | "TileGrid"
  | "Time"
  | "TimeFields"
  | "Title"
  | "Toasts"
  | "Toolbar"
  | "Tooltip"
  | "TopBar"
  | "Waveform"
  | "addDays"
  | "addMonths"
  | "ago"
  | "appBase"
  | "bars"
  | "bytes"
  | "clampDayTime"
  | "clock"
  | "closePalette"
  | "code128"
  | "connect"
  | "defineWords"
  | "dismissToast"
  | "display"
  | "documentPdf"
  | "download"
  | "exportFile"
  | "fill"
  | "formatDate"
  | "formatDateTime"
  | "formatDay"
  | "formatDayTime"
  | "formatList"
  | "formatNumber"
  | "formatPattern"
  | "formatTime"
  | "go"
  | "humanize"
  | "iconOf"
  | "isDay"
  | "isDayTime"
  | "keep"
  | "kept"
  | "knownWords"
  | "lang"
  | "message"
  | "node"
  | "nowIn"
  | "openLink"
  | "openPalette"
  | "optionId"
  | "parseDay"
  | "parsePattern"
  | "partsOfDayTime"
  | "presetRange"
  | "rangePresets"
  | "remind"
  | "resample"
  | "safeHref"
  | "sayText"
  | "setWords"
  | "shortcutLabel"
  | "signInPageOf"
  | "signOut"
  | "surface"
  | "tableAddress"
  | "tablePdf"
  | "tableQuery"
  | "tableState"
  | "tableView"
  | "tell"
  | "textWidth"
  | "toCsv"
  | "toExcel"
  | "toJson"
  | "toPdf"
  | "toSql"
  | "toXlsx"
  | "toXml"
  | "toast"
  | "todayIn"
  | "useFormState"
  | "useFormSubmit"
  | "useRefresh"
  | "useShortcuts"
  | "web"
  | "wordsOf"
  | "wrapText"
>;

// Generated from git show 2383779c:hosts/web/export.ts.
export type {
  Drawn as ServerDrawn,
  ExportFormat as ServerExportFormat,
  ExportOptions as ServerExportOptions,
  PageSize as ServerPageSize,
  PdfFont as ServerPdfFont,
  PdfOptions as ServerPdfOptions,
  Sheet as ServerSheet,
} from "../export.ts";
export type FileValues = Pick<
  typeof import("../export.ts"),
  | "EXPORT_FORMATS"
  | "bars"
  | "code128"
  | "documentPdf"
  | "exportFile"
  | "tablePdf"
  | "textWidth"
  | "toCsv"
  | "toExcel"
  | "toJson"
  | "toPdf"
  | "toSql"
  | "toXlsx"
  | "toXml"
  | "wrapText"
>;
