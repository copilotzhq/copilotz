/**
 * The web host, for the browser: `web()` runs the app there, as the signed-in
 * person, in the app's theme. What features' web front ends use, as they'd
 * use React: `Part`, `LazyView` (a View shown only while a component is),
 * `go` (moving on without reloading), `signOut`, the command palette's
 * items and steps (`openPalette`, at a step, from anywhere), and the toolkit
 * (`toolkit/`), whose pieces take their look from the theme's variables
 * (`theme/`): a front end composes them, and its own CSS is only its layout,
 * on those variables. The server half is `server.ts` (the page, as a
 * plugin: `webPage`), for the runtime that serves it.
 */
export { go, signOut, web, type WebOptions, type Where, type Who } from "./host.tsx";
export { appBase } from "./base.ts";
// The words every front end says, by key: the app's `words` resource over the English.
export {
  type Blanks,
  defineWords,
  fill,
  formatDate,
  formatDateTime,
  formatList,
  formatNumber,
  formatTime,
  knownWords,
  lang,
  type Phrase,
  type Say,
  sayText,
  setWords,
  type Words,
  wordsOf,
} from "./words.ts";
export { message, node, Part } from "./part.tsx";
// Where Views are drawn (the page, or a widget in an outside assistant), and what a widget asks of
// its host: no-ops on the page.
export {
  display,
  type DisplayMode,
  openLink,
  remind,
  surface,
  tell,
  useRefresh,
} from "./surface.ts";
export { LazyView } from "./lazy.tsx";
// The command palette: the page's (the shell shows it), and opening it at a step from anywhere.
export { Palette } from "./palette/palette.tsx";
export {
  closePalette,
  openPalette,
  type PaletteControl,
  type PaletteDialog,
  type PaletteGroup,
  type PaletteItem,
  type PaletteStep,
} from "./palette/state.ts";
export { DEFAULT_THEME, type Theme } from "./theme/default.ts";
// What the sign-in page says, as the app's (its `signInPage` resource): every word, and the panel
// beside the form.
export {
  COPILOTZ_ABOUT,
  SIGN_IN_WORDS,
  type SignInAbout,
  type SignInPage,
  signInPageOf,
  type SignInPoint,
  type SignInWords,
} from "./signin-words.ts";
export type { Drawing, Picture } from "./theme/picture.ts";

// The toolkit: actions and fields.
export { Button, type ButtonProps } from "./toolkit/button.tsx";
export { IconButton, type IconButtonProps } from "./toolkit/icon-button.tsx";
export { CopyButton } from "./toolkit/copy-button.tsx";
export { Input } from "./toolkit/input.tsx";
export { InlineEdit } from "./toolkit/inline-edit.tsx";
export { Textarea } from "./toolkit/textarea.tsx";
export { type Control, Field } from "./toolkit/field.tsx";
export { Select } from "./toolkit/select.tsx";
export { Checkbox } from "./toolkit/checkbox.tsx";
export { Radio } from "./toolkit/radio.tsx";
export { Switch } from "./toolkit/switch.tsx";
export { TagsInput } from "./toolkit/tags-input.tsx";
export { MultiPicker, Picker, type PickerOption } from "./toolkit/picker.tsx";
export { FileInput } from "./toolkit/file-input.tsx";
export { RowsEditor } from "./toolkit/rows-editor.tsx";
// Forms whose parts (another plugin's View too) take part in one save.
export {
  Form,
  type PartAnswer,
  type PartSubmit,
  useFormState,
  useFormSubmit,
} from "./toolkit/form.tsx";
export { Autocomplete, type AutocompleteOption, optionId } from "./toolkit/autocomplete.tsx";
// Surfaces and labels.
export { Card } from "./toolkit/card.tsx";
export { Badge, type Tone } from "./toolkit/badge.tsx";
export { Chip } from "./toolkit/chip.tsx";
export { Avatar } from "./toolkit/avatar.tsx";
export { Icon, type IconLike, type IconName, iconOf, ICONS } from "./toolkit/icon.tsx";
export { Logo } from "./toolkit/logo.tsx";
// Overlays and navigation.
export { Menu, type MenuItem, type MenuTrigger } from "./toolkit/menu.tsx";
export { Popover, type PopoverTrigger } from "./toolkit/popover.tsx";
export { Dialog } from "./toolkit/dialog.tsx";
// Asking before going on (a delete), and a record in a dialog, to add or change.
export {
  confirm,
  ConfirmDialog,
  type ConfirmDialogProps,
  type ConfirmOptions,
} from "./toolkit/confirm-dialog.tsx";
export {
  EntityDialog,
  type EntityDialogProps,
  type EntityField,
  type EntityForm,
} from "./toolkit/entity-dialog.tsx";
export { Drawer } from "./toolkit/drawer.tsx";
export { type Tab, Tabs } from "./toolkit/tabs.tsx";
export { NavItem } from "./toolkit/nav-item.tsx";
export { RailItem, type RailItemProps } from "./toolkit/rail-item.tsx";
export { ResizeHandle } from "./toolkit/resize-handle.tsx";
export { Tooltip } from "./toolkit/tooltip.tsx";
// Laying a screen out without CSS: stacks, grids, toolbars, two columns, lists, words.
export { type Space } from "./toolkit/space.tsx";
export { type Align, Divider, type Justify, Spacer, Stack } from "./toolkit/stack.tsx";
export { Grid, GridItem } from "./toolkit/grid.tsx";
export { Toolbar } from "./toolkit/toolbar.tsx";
export { Screen } from "./toolkit/screen.tsx";
export { Split } from "./toolkit/split.tsx";
export { ListGroup, type ListGroupItem } from "./toolkit/list-group.tsx";
export { Heading, Text, type TextTone } from "./toolkit/text.tsx";
// An app's own bars and home, without the Copilotz shell.
export { AppBar, type AppBarItem, TopBar } from "./toolkit/app-bar.tsx";
export { type Tile, TileGrid } from "./toolkit/tile-grid.tsx";
// Tables: rows to read, find and act on, their pages, and their files.
export { DataTable, type ExportChoice, TableExportFormats } from "./toolkit/data-table.tsx";
export { Pagination } from "./toolkit/pagination.tsx";
export {
  type Column,
  type Key as RowKey,
  PAGE_SIZES,
  type TableState,
  tableView,
} from "./toolkit/table.ts";
export { tableAddress, tableQuery, tableState } from "./table-address.ts";
export {
  download,
  EXPORT_FORMATS,
  type ExportCell,
  exportFile,
  type ExportFormat,
  type ExportOptions,
  type Sheet,
  type TableExportFormat,
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
// Dates: days as `YYYY-MM-DD`, in the app's format and time zone.
export {
  Calendar,
  type CalendarValue,
  type DayFormat,
  formatDay,
  parseDay,
} from "./toolkit/calendar.tsx";
export {
  DatePicker,
  DateRangePicker,
  type RangePreset,
  rangePresets,
  STANDARD_PRESETS,
} from "./toolkit/date-picker.tsx";
export {
  addDays,
  addMonths,
  clampDayTime,
  type DateRange,
  type DayTime,
  formatPattern,
  isDay,
  isDayTime,
  nowIn,
  parsePattern,
  partsOfDayTime,
  type Preset,
  presetRange,
  todayIn,
} from "./toolkit/dates.ts";
export {
  type Clock,
  DateTimePicker,
  type DayTimeFormat,
  formatDayTime,
  TimeFields,
} from "./toolkit/date-time-picker.tsx";
// Typed day-times read back in the app's pattern, and the moment one names.
export { dateOfDayTime, parseDayTime } from "./toolkit/dates.ts";
export { LiveClock } from "./toolkit/live-clock.tsx";
// Telling: a few seconds' word over the page.
export {
  dismissToast,
  toast,
  type ToastOptions,
  type ToastPlacement,
  Toasts,
  type ToastTone,
} from "./toolkit/toast.tsx";
// A screen's keyboard shortcuts, and what a printed page leaves out.
export { type Binding, shortcutLabel, useShortcuts } from "./toolkit/shortcuts.ts";
export { NoPrint, PrintOnly } from "./toolkit/print.tsx";
// Barcodes: Code 128, drawn, and as bars for a document made elsewhere.
export { Barcode } from "./toolkit/barcode.tsx";
export { barcodePng } from "./toolkit/barcode-png.ts";
export { code39, ean13, ean8, eanDigits } from "./toolkit/retail-barcodes.ts";
export { type PdfImage, pdfImage } from "./toolkit/pdf-image.ts";
export { type BarcodeOptions, bars, code128 } from "./toolkit/code128.ts";
// Pages and details.
export { Page } from "./toolkit/page.tsx";
export { type Detail, DetailList } from "./toolkit/detail-list.tsx";
export { DetailValue } from "./toolkit/detail-value.tsx";
export { humanize } from "./toolkit/humanize.ts";
// Status and text.
export { Spinner } from "./toolkit/spinner.tsx";
export { Skeleton } from "./toolkit/skeleton.tsx";
export { EmptyState } from "./toolkit/empty-state.tsx";
export { Notice } from "./toolkit/notice.tsx";
export { Kbd } from "./toolkit/kbd.tsx";
export { ago } from "./toolkit/ago.ts";
export { keep, kept } from "./toolkit/kept.ts";
export { Time } from "./toolkit/time.tsx";
export { LongText } from "./toolkit/long-text.tsx";
export { CodeBlock, type CodePart, type CodeTone } from "./toolkit/code-block.tsx";
export { bytes } from "./toolkit/bytes.ts";
export { Markdown } from "./toolkit/markdown/markdown.tsx";
export { safeHref } from "./toolkit/markdown/spans.ts";
export { Title } from "./toolkit/title.tsx";
// A terminal, for a shell that runs a line at a time.
export { Terminal, type TerminalOutput, type TerminalSession } from "./toolkit/terminal.tsx";
// Sound.
export { AudioPlayer } from "./toolkit/audio-player.tsx";
export { Waveform } from "./toolkit/waveform.tsx";
export { resample } from "./toolkit/resample.ts";
export { clock } from "./toolkit/clock.ts";
// The client a page connects with (over Oxian, or over a host's link: a widget's), for an app's
// own tests and hosts too.
export { type Client, type ClientLink, connect, type Known } from "../../runtime/client.ts";
// What a route is handed of the app's widgets (the server's half, `copilotz/web/server`).
export type { Widgets } from "./widgets.ts";

export { tableSheet } from "./toolkit/table.ts";
