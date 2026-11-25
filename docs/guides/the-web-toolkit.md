---
title: "The web toolkit"
description: "The pieces web front ends are made of, laid out and themed without CSS: layout, forms, table exports and totals, dates, bars, toasts, shortcuts, printing, PDF logos, Code 39, Code 128 and EAN barcodes, a route's own page and a sign-in (`Screen`), and every token a theme sets."
section: Guides
order: 8
---

# The web toolkit

`copilotz/web` exports the pieces every web front end is made of: buttons and fields, tables, date
pickers, dialogs, bars, toasts, and the layout pieces that place them. A screen composes them and
writes no CSS. Its look is the app's theme: the theme's tokens set the colours, fonts and radii, and
each piece's own tokens set its sizes and surfaces. `className` stays on most pieces as an escape
hatch for what no token reaches. A printed document (a receipt, an invoice) is the one place for an
app's own CSS: its print layout.

```tsx
import { Button, DataTable, Field, Input, Page, Stack, Toolbar } from "copilotz/web";
```

## Theming without CSS

A theme is a `theme` resource (see
[The web's look and words](../reference.md#the-webs-look-and-words)). It sets three kinds of tokens:

- **The theme's own** in `light` and `dark`: `primary`, `background`, `border`, `success`… (shadcn's
  names, and the toolkit's), with `radius` and `font`. Every piece reads them.
- **The same on both screens** in `tokens`: sizes, paddings, radii, weights, and the spacing scale.
  They're written on `:root` before `light`'s, so a colour set in `light` wins on a clash.
- **Each piece's own** (`button-height`, `table-stripe`, `dialog-head-background`…), in `tokens`
  when it's a size and in `light`/`dark` when it's a colour. Every one has a default, which is
  Copilotz's look, so a theme sets only what it changes. [The tables below](#every-pieces-tokens)
  list them all.

```ts
definePlugin({
  name: "brand",
  resources: {
    theme: {
      radius: "6px",
      tokens: { "button-height": "34px", "input-height": "34px", "space-md": "10px" },
      light: {
        primary: "#0f766e",
        "table-stripe": "color-mix(in oklab, var(--muted) 50%, transparent)",
      },
      dark: { primary: "#2dd4bf", "primary-foreground": "#042f2e" },
    },
  },
});
```

A token is a CSS variable (`var(--button-height)`), so a value may use the theme's own
(`var(--muted)`). A piece's token never changes a theme token's meaning: `primary` is still the
brand everywhere.

## Laying out a screen

`Page` is a View's frame: its title, actions, description, and the width it centres at
(`align="center"` centres the title and description too). Inside it, these place things without CSS,
and `hidden` hides any of them. Gaps are steps of one spacing scale, `xs` (4px), `sm` (8px), `md`
(12px), `lg` (16px), `xl` (24px), `2xl` (32px), each a token (`space-md`).

| Piece               | What it is                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Stack`             | Things one after another, down (`direction="column"`, the default) or along (`row`): `gap`, `align`, `justify`, `wrap`; `as` makes it a `form`, a `section`, a list.                                   |
| `Spacer`, `Divider` | The room left in a row, pushing what follows to its end; a line between parts.                                                                                                                         |
| `Grid`, `GridItem`  | Columns: `columns={3}`, a template (`"1fr 2fr"`), or as many as fit (`min="220px"`). One column when the grid itself is narrower than `collapse` (`sm`, 480px, by default). `GridItem span={2}` spans. |
| `Toolbar`           | A row of controls over what they act on: `start` (the screen's actions), `grow` (a field taking the room left), `end` (filters, dates); it wraps.                                                      |
| `Split`             | Two columns: the screen's main one, and an `aside` that stays in view (`sticky`), at the `end` or `start`, `sm`/`md`/`lg` wide; they stack when narrow.                                                |
| `Card`              | A surface; with `title` (and `icon`, `action`), a heading over its body.                                                                                                                               |
| `ListGroup`         | Rows one under another: links, actions, or text, with a description, an icon and an `end`; the `active` one marked. `flush` inside a card.                                                             |
| `Screen`            | A frame that fills the window: what it holds centred in the window's height at `screen-width`, and a `footer` kept at the window's foot. For a sign-in or a route's own page.                          |
| `Text`, `Heading`   | Words in the theme's type: `Text` with a `size`, `tone`, `weight`, `align`, `mono`, `truncate`; `Heading` `h1` to `h4`.                                                                                |

A list screen:

```tsx
<Page
  title="Items"
  width="lg"
  actions={<Button variant="primary" icon="plus" href="/items/new">New item</Button>}
>
  <Stack gap="lg">
    <Toolbar end={<DateRangePicker value={range} onChange={setRange} today={today} presets />} />
    <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} exportName="items" />
  </Stack>
</Page>;
```

A visit being booked, its services beside its total:

```tsx
<Split aside={<Card title="Total"><Stack>…<Button variant="primary" block>Book the visit</Button></Stack></Card>} sticky label="Total">
  <Stack>
    <Autocomplete … />
    <DataTable columns={chosen} rows={services} rowKey={(s) => s.id} toolbar={false} pagination={false} />
  </Stack>
</Split>
```

Reports, as a card of links:

```tsx
<Grid min="280px">
  <Card title="Summary reports" icon="chart" padding="none">
    <ListGroup
      flush
      items={[{ href: "/reports/visits", label: "Visits", description: "By day" }]}
    />
  </Card>
</Grid>;
```

**A page that is the whole window.** `Page` frames a View under its title, at a width. A page with
no title over it, a sign-in, a landing, an error, or a route's own page, is a `Screen`: it fills the
window (at least its height), centres what it holds both ways at `screen-width` (420px), and keeps
its `footer` at the window's foot. Taller than the window, it grows, and the footer follows it.

```tsx
<Screen
  footer={
    <Text size="sm" tone="muted">
      Acme Salon · <a href="/help">Help</a>
    </Text>
  }
>
  <Card title="Sign in">
    <Stack as="form" method="post" action="/sign-in">
      <Field label="Email" htmlFor="email" required>
        <Input id="email" name="email" type="email" autoComplete="username" />
      </Field>
      <Field label="Password" htmlFor="password" required>
        <Input id="password" name="password" type="password" autoComplete="current-password" />
      </Field>
      <Button type="submit" variant="primary" block>Sign in</Button>
    </Stack>
  </Card>
</Screen>;
```

## Forms

- **`Field`** labels a control: a `hint` under it, or the `error` in its place. `required` adds a
  mark that screen readers say as "required". Its children are a function of the control's props, or
  the control itself with `htmlFor`. `layout="row"` puts the label in a column beside the control,
  and it stacks again under 560px. `labelWidth` (30% by default) and `controlWidth` (the rest by
  default) are each a share of the whole row, as a grid's columns are: `"33.33%"` and `"66.67%"`
  fill the row, `"25%"` and `"50%"` leave its last quarter empty, and a length (`"320px"`) is the
  most the control takes. The tokens `field-row-label-width` and `field-row-control-width` set them
  for every field. Before rc.54, `controlWidth` was a share of the control's own column: an older
  `"50%"` beside a 30% label is now about `"35%"`.
- **`Input`**: `sm`, `md`, `lg`; an `icon` inside the box; `end` for buttons that act on it;
  **`addon`** and **`addonEnd`**, segments outside the box and joined to it: words or an icon get a
  tinted face, and a button or a `Switch` there is the segment itself.
- **`Select`** (with `addon` and `addonEnd`, as `Input`'s), **`Textarea`**, **`Checkbox`**, and
  **`Radio`** (radios sharing a `name` are one choice).
- **`Switch`**: a setting that takes effect as it's flipped (`role="switch"`), with words `on` and
  `off` if wanted; `joined="end"` in an `addonEnd`.
- **`TagsInput`**: values as tags. Enter or a comma adds what's typed, a paste of "a, b, c" adds
  three, Backspace in the empty field removes the last; no duplicates; `name` sends them as one
  comma-separated value.
- **`Picker`** and **`MultiPicker`**: a choice the app draws, not the browser: a button showing the
  choice, opening its options. `search` puts a box over a long list. `MultiPicker` ticks several and
  says "None chosen", the one chosen, or "{count} chosen". `name` sends the choice with a form. Both
  take `addon` and `addonEnd`.
- **`FileInput`**: the browser's own file field (`name`, `accept`, `multiple`, `required`, so a form
  sends the files), drawn as a toolkit field: a button ("Choose a file", then "Change"), what's
  chosen, and Remove. Files dropped on it are chosen too, only those `accept` takes.
  `onChange(files)` hears each change. `chooseLabel`, `changeLabel` and `removeLabel` are one
  field's own words ("Select image"); `current` names a file already stored (its name or address),
  shown until another is chosen, and its Remove calls `onRemove`.
- **`RowsEditor`**: a list of records edited as one form, one row of fields each
  (`render(row,
  index, set)`), numbered, with a button to add a row after each and to remove it,
  "Add a row" at the end, `min` and `max`, and an `error` under a row. Adding focuses the new row's
  first field. `add={false}` leaves the add buttons out; `removeIcon` and `removeLabel` set the
  remove button.
- **`Button`**: `primary`, `secondary`, `outline` (the default), `ghost`, `destructive`, `success`,
  `info`, `warning`, `link`; `xs`, `sm`, `md`, `lg`; `block` fills its box.

```tsx
<Stack as="form" onSubmit={save}>
  <Field layout="row" label="Email" htmlFor="email" required error={errors.email}>
    <Input id="email" type="email" icon="mail" />
  </Field>
  <Field layout="row" label="Postcode" htmlFor="postcode" controlWidth="35%">
    <Input id="postcode" autoComplete="postal-code" />
  </Field>
  <Field layout="row" label="Discount" htmlFor="discount">
    <Input
      id="discount"
      inputMode="decimal"
      addonEnd={
        <Switch
          joined="end"
          label="Discount type"
          checked={fixed}
          onChange={setFixed}
          on="$"
          off="%"
        />
      }
    />
  </Field>
  <Field layout="row" label="Customer" htmlFor="customer">
    <Picker
      id="customer"
      label="Customer"
      search
      value={customer}
      options={customers}
      onChange={setCustomer}
    />
  </Field>
  <Stack direction="row" justify="end">
    <Button type="submit" variant="primary">Save</Button>
  </Stack>
</Stack>;
```

```tsx
<RowsEditor
  label="Rooms"
  rows={codes}
  onChange={setCodes}
  make={() => ({ code: "", name: "" })}
  error={(row) => (row.code ? undefined : "Give the code.")}
  render={(row, _i, set) => (
    <Grid columns="1fr 2fr" collapse={false}>
      <Input
        aria-label="Code"
        value={row.code}
        onChange={(e) => set({ ...row, code: e.target.value })}
      />
      <Input
        aria-label="Name"
        value={row.name}
        onChange={(e) => set({ ...row, name: e.target.value })}
      />
    </Grid>
  )}
/>;
```

**A form with parts.** `Form` is a `<form>` whose parts take part in its save: each joins with
`useFormSubmit(handler)`, another plugin's View shown inside it too (a shown View is in the form's
React tree). On submit, each part's handler runs in the order they joined: values it returns are
handed to the form's `onSubmit(values, form)`; nothing means it saved its own part; `false` stops
the save (the part says why); a throw stops it, and the form says the failure's words at its top.
`useFormState()` tells buttons it's `submitting`; outside a `Form`, `useFormSubmit` says
`inForm: false`, so a part can show its own Submit. Handing values up and saving them in one Action
keeps the save one transaction.

```tsx
<Form
  onSubmit={(values, form) =>
    ctx.call("bookings.settings.save", { on: new FormData(form).has("on"), hours: values.hours })}
>
  <Checkbox name="on" label="Take bookings online" />
  {ctx.show("panel:opening_hours", {})}
  <Button type="submit" variant="primary">Save</Button>
</Form>;
// In the panel's View:
const { inForm } = useFormSubmit(() => (valid(rows) ? { hours: rows } : false));
```

**Dialogs:** `Dialog` is the browser's modal `<dialog>`. `placement="top"` opens it near the top
instead of centred, and `focus="dialog"` gives the focus to the dialog itself rather than its first
field (Tab then goes to it). `size` is `sm`, `md`, `lg` or `auto`.

## Tables and their files

`DataTable` lists rows: a toolbar (the screen's actions at its start, then a search box, a column
chooser and an export menu), headers that sort, a checkbox per row when there are `actions`, and
pages under it. Columns are data:

```tsx
const columns: Column<Item>[] = [
  { key: "id", title: "ID", numeric: true, width: "80px" },
  { key: "name", title: "Name" },
  { key: "price", title: "Price", align: "right", text: (i) => money(i.price) },
  { key: "edit", title: "", label: "Edit", render: (i) => <Button size="xs" href={`/items/${i.id}`}>Edit</Button> },
];
<DataTable columns={columns} rows={items} rowKey={(i) => i.id} exportName="items"
  actions={(ticked, clear) => <Button size="sm" icon="trash" disabled={!ticked.length} onClick={…}>Delete</Button>} />
```

- A column titled `""` holds links or buttons: it isn't sorted, searched, chosen or exported; its
  `label` names it for screen readers. `text` is what search, sorting and the files use; `numeric`
  sorts by number; `hidden` starts it hidden in the chooser.
- **Search** finds every word typed in any titled column, whatever its case and accents ("zoe
  muller" finds "Zoë Müller"), 500 ms after the last key.
- A click on a row ticks it (not on a link, button or field in it); the header's box ticks the page.
  `actions(ticked, clear)` gets the ticked rows' keys.
- `detail(row)` opens a row under each, by a button with `aria-expanded`; `detailOpen` opens them
  all (`true`, with no button) or those a function picks.
- Fields in cells fill their column and shrink with it. `layout="fixed"` keeps the columns at their
  `width`s.
- `search`, `chooseColumns`, `exports`, `toolbar` and `pagination` set to `false` take each away;
  `pageSizes` sets the sizes (10, 25, 50, 100 by default).

**Two modes.** By default the table has every row, and searches, sorts and pages them itself. With a
`total`, it shows the page it's given, and its `state` (`{ search, sort, order, offset, limit }`) is
the View's to read its query with. `tableAddress(where, 25)` keeps that state in the page's address,
so Back goes back a page:

```tsx
const page = ctx.db.collection("item").query<{ rows: Item[]; total: number }>(
  "page",
  tableState(where, 25),
);
<DataTable
  {...tableAddress(where, 25)}
  total={page.value?.total ?? 0}
  rows={page.value?.rows ?? []}
  loading={page.status === "loading"}
  columns={columns}
  rowKey={(i) => i.id}
/>;
```

**Fields in cells.** A column's `render` may return fields: a click in a toolkit field, a link or a
button is that control's, never a tick of the row, and the table handles no key of its own. Keep the
edits per row and send a row with its Update button, or Enter in one of its fields; turn sorting off
on the columns being edited (`sortable: false`), or rows move while someone types.

```tsx
const field = (key: "cost" | "quantity", label: string) => (l: Line) => (
  <Input
    size="sm"
    aria-label={label}
    inputMode="decimal"
    value={String(draft(l)[key])}
    onChange={(e) => edit(l, { [key]: e.target.value })}
    onKeyDown={(e) => e.key === "Enter" && save(l)}
  />
);
<DataTable
  rows={lines}
  rowKey={(l) => l.id}
  toolbar={false}
  pagination={false}
  columns={[
    { key: "name", title: "Item", sortable: false },
    { key: "cost", title: "Cost", sortable: false, width: "110px", render: field("cost", "Cost") },
    {
      key: "quantity",
      title: "Quantity",
      sortable: false,
      width: "90px",
      render: field("quantity", "Quantity"),
    },
    {
      key: "update",
      title: "",
      label: "Update",
      render: (l) => <Button size="xs" onClick={() => save(l)}>Update</Button>,
    },
  ]}
/>;
```

`tableQuery(where, state, extra)` writes the address's query, keeping its other keys, and
`tableView(rows, columns, state)` searches, sorts and pages a list as the table does (for a query
that pages one in memory). `Pagination` is the pages on their own.

## Exporting a table

The export menu saves the visible columns of the rows shown (every matching row, with `exportAll`)
as `<exportName>.<ext>`; `exports` picks the formats (`["csv", "xlsx", "pdf"]` by default):

| Format              | File                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csv`               | every cell quoted, with a BOM so Excel reads accents (`bom: false` leaves it out)                                                                                          |
| `xlsx`              | a real workbook: numbers stay numbers, `007` stays text, never a formula                                                                                                   |
| `pdf`               | Helvetica, A4 landscape, the header on every page; `title`, `orientation`, `headerColor`, `headerText`, `stripeColor`, `fontSize`; text outside Windows-1252 prints as "?" |
| `json`              | records by header (`json: "table"`: `{ header, data }`)                                                                                                                    |
| `xml`, `txt`, `sql` | `<tabledata>`; CSV again; one `INSERT` per row                                                                                                                             |
| `excel`             | an HTML table as `.xls` (Excel warns as it opens it)                                                                                                                       |

CSV, TXT and `.xls` guard against formula injection: a cell starting `=`, `+`, `-` or `@` gets a
leading `'` (plain numbers such as `-12.5` don't; `formulas: true` turns it off).
`exportFile(format, sheet, name, options)` gives `{ file, type, content }`, on a server too (an
e-mailed PDF); `download(…)` saves it in the browser.

A format has a label, extension, MIME type and serializer. The serializer receives a sheet of
visible headers, keys, rows and footer rows, followed by the base name and the export options.
Return text or bytes. Use a built-in name such as `csv` to replace its format. Put `formats` on a
table, or put `<TableExportFormats value={formats}>` around the screens in the app's shell. A
table's definitions win. The default menu adds the supplied formats to CSV, Excel and PDF. An
explicit `exports` list sets the exact menu and order.

```tsx
import { DataTable, type TableExportFormat } from "copilotz/web";

const products = [{ name: "Coffee", units: 12 }];
const columns = [{ key: "name", title: "Product" }, { key: "units", title: "Units" }];
const formats = {
  jsonl: {
    label: "JSON Lines",
    extension: "jsonl",
    type: "application/x-ndjson",
    serialize: ({ headers, rows, footerRows = [] }) =>
      [...rows, ...footerRows].map((row) =>
        JSON.stringify(Object.fromEntries(headers.map((h, i) => [h, row[i]])))
      ).join("\n"),
  },
} satisfies Record<string, TableExportFormat>;

<DataTable
  rows={products}
  columns={columns}
  rowKey={(p) => p.name}
  footerRows={[{ name: "Total", units: 12 }]}
  formats={formats}
  exports={["csv", "json", "sql", "pdf", "jsonl"]}
  exportName="stock"
  exportOptions={{
    values: "raw",
    json: "records",
    tableName: "products",
    csv: { quote: "needed", delimiter: ";", lineEnding: "\r\n", finalNewline: true, header: true },
  }}
/>;
```

- **Values.** Files use each column's `text(row)` by default. Give a rendered cell a `text` function
  for its words. `values: "raw"` reads the fields by column key and preserves scalar values for
  typed formats. Untitled button columns stay on screen.
- **Totals.** Give `footerRows` as records keyed by column. The same totals appear under the table
  and in every built-in file, even when someone hides a column. The app supplies totals for the
  desired range. The older `footer` slot draws any extra markup on screen.
- **CSV and TXT.** The defaults are `quote: "always"`, a comma (use any single delimiter character
  except a quote or line break), `lineEnding: "\n"`, a header and no final newline. With
  `quote: "needed"`, a quote, delimiter or line break in a field makes it quoted. Set
  `header: false` to start with the first data row. Set `bom: false` on `exportOptions` for a file
  without the byte-order mark.
- **JSON and SQL.** `json: "records"` gives objects by header. `json: "table"` gives
  `{ header, data }` with cells keyed by position. Its default is text and `values: "raw"` preserves
  their scalar types. `tableName` sets the SQL table independently of the file name.
- **In an Action.** Import `exportFile` from `copilotz/web/export`. Give it a sheet with
  `{ headers, rows, footerRows }`, in column order, or use
  `tableSheet(chosenColumns, rows, totalsByKey, "raw")` to make one. A server-paged table can export
  the rows it has. For the whole list, the Action reads the matching rows as its caller.

With `values: "raw"`, XLSX stores strings as text cells and finite numbers as numeric cells. PDF
column widths and alignments follow the visible titled columns in export order. When CSV uses
`quote: "needed"`, a row containing one empty field is written as `""`.

## A toolbar of your own

Give `toolbar` a button or filter to put it beside the built-in controls. Use `actions` for buttons
that take selected rows. `showSinglePageSize` keeps the page-size menu visible when one size fits.

```tsx
<DataTable
  rows={products}
  columns={columns}
  rowKey={(p) => p.name}
  toolbar={<Button href="/products/new">New product</Button>}
  pageSize={25}
  pageSizes={[25]}
  showSinglePageSize
/>;
```

## Printing a table

Use `tablePdf` from `copilotz/web/export` in an Action to make attachment bytes, or give `DataTable`
the same layout in `exportOptions.pdf`. Named paper (`"a4"` or `"letter"`) defaults to landscape. A
`[width, height]` pair uses points (72 per inch). The first page holds the logo and title lines,
every page repeats the column headings, and totals print in bold after the last row.

```ts
import { pdfImage, tablePdf } from "copilotz/web/export";

export async function invoicePdf(logoBytes: Uint8Array) {
  const logo = await pdfImage(logoBytes);
  return tablePdf({
    headers: ["Product", "Amount"],
    rows: [["Coffee", "12.50"]],
    footerRows: [["Total", "12.50"]],
  }, {
    size: "letter",
    orientation: "portrait",
    fontSize: 10,
    title: "Invoice 1042",
    subtitle: ["Customer 27", "November orders"],
    headerImage: { image: logo, width: 60, height: 60 * logo.height / logo.width },
    columns: [{}, { width: 90, align: "right" }],
  });
}
```

Each fixed column width is in points. The other columns share the remaining width. Alignment is
`"left"`, `"center"` or `"right"`. On a `DataTable`, list PDF columns in the order of its titled
columns. The table keeps widths and alignment with their fields when the chooser hides one.

## Dates

Days are `YYYY-MM-DD` strings, in the app's time zone: `todayIn("America/New_York")` is the app's
today, which every picker takes as `today` (never the browser's clock when given). `format` is a
pattern (`dd/MM/yyyy`, `d MMM yyyy`; `yyyy yy MMMM MMM MM M dd d EEEE EEE`, and `'quoted words'`) or
a function of the day; by default, the page language's short date. Month and weekday names are the
page language's.

- **`DateRangePicker`**: a field showing the range; open, the presets beside two months (stacked on
  a phone), with the range's From and To over the months as typed fields. A preset applies at once;
  the first day clicked starts a range and the second ends it; Apply takes it, Cancel or Escape keep
  the value, and both stay in view when the panel scrolls. From and To are written and read in the
  field's `format`: a day typed moves the range and the months shown, and anything else (not a day,
  or outside `min` and `max`) is marked and changes nothing. Give `format` as a pattern where people
  type: a function can't be read back, so typed text is then read as the page language's short date
  or as `YYYY-MM-DD`. A long range opens on its start's months. `presets` is a list, `true` for the
  standard ones, or `false`; `min` and `max` bound what can be picked; `separator` sits between the
  days. From and To are the words `toolkit.rangeFrom` and `toolkit.rangeTo`.
- **`DateRangePicker` with `time`**: each end has hours and minutes too, and the ends are
  `YYYY-MM-DD HH:mm`; a preset is its whole days, `00:00` to `23:59`. On one day, the end is never
  before the start. A stored time with seconds sorts after its minute (`"… 23:59:30" > "… 23:59"`),
  so compare one with an end to the minute: `at.slice(0, 16) <= range.end`.
- **`rangePresets(today, { keys, fiscalYearStart, min, max })`** builds presets by key, in the order
  given: `today`, `yesterday`, `todayLastYear`, `last7Days`, `last30Days`, `thisMonth`,
  `sameMonthToDateLastYear`, `sameMonthLastYear`, `lastMonth`, `thisYear`, `lastYear`,
  `thisFiscalYear`, `lastFiscalYear`, `allTime` (with a `min`). Their labels are words
  (`toolkit.thisMonth`), so an app renames them with its `words`.
- **`DatePicker`**: one day, one month; picking closes it.
- **`DateTimePicker`**: a day and a time of it, in the app's clock time with no zone (as `LiveClock`
  writes it): `YYYY-MM-DD HH:mm`, or `YYYY-MM-DD HH:mm:ss`. Opened, the month and the time's fields,
  each typed or stepped with the arrows (the minutes by `minuteStep`); Apply takes both. A value's
  seconds are kept until its time is changed, so a form that saves a record's time unchanged keeps
  them; changing the hours or minutes drops them, unless `seconds` shows them in a field of their
  own (the value then always has them, `:00` when it had none). A `format` shows them with `ss`
  (`dd/MM/yyyy HH:mm:ss`); the default one shows them when the value has them. `min` and `max` are
  days or day-times; with no value it opens at the app's now (`timeZone`). `name` sends the value
  with a form.
- **`TimeFields`**: a time of day's fields alone, the pickers' own: hours, minutes, and `seconds` if
  wanted; its value is a `Clock`, `{ hour, minute, second? }`.
- **`Calendar`**: one month's grid, alone: arrows move a day, Page Up and Page Down a month (a year
  with Shift), Home and End the week's ends, Enter or Space pick; each day is named by its full
  date.
- **`LiveClock`**: now, in a `format` and a `timeZone`, ticking each second (each minute when the
  format shows no seconds); nothing on the server.
- **Helpers:** `isDay` and `isDayTime`; `partsOfDayTime` (`{ day, hour, minute, second? }`);
  `addDays` and `addMonths`; `clampDayTime(value, min, max)`; `nowIn(timeZone, step, at, seconds)`,
  now (or the `Date` `at`) as the app's day-time; `formatDay` and `parseDay`, a day written in a
  picker's `format` and read back; `formatDayTime`; `formatPattern` and `parsePattern`, which take a
  time's letters too (`HH`, `hh`, `mm`, `ss`, `a`).

```tsx
<DateRangePicker
  value={range}
  onChange={setRange}
  today={today}
  format="dd/MM/yyyy"
  presets={rangePresets(today, { fiscalYearStart: 4, min: "2010-01-01", max: today })}
  min="2010-01-01"
  max={today}
/>;
// Shifts, each end with its time: { start: "2026-11-02 08:00", end: "2026-11-08 17:30" }
<DateRangePicker value={shifts} onChange={setShifts} today={today} format="dd/MM/yyyy" time />;
// A stored time, "2026-11-16 14:30:05": saved unchanged, it keeps its seconds.
<DateTimePicker
  label="Received"
  value={received}
  onChange={setReceived}
  format="dd/MM/yyyy HH:mm:ss"
  timeZone={zone}
  name="received_at"
/>;
```

## Bars, tiles and toasts

For an app without the Copilotz shell:

- **`AppBar`**: the brand (words or a `Logo`; with `href`, home), the places
  (`items: { href, label, icon?, key? }`), and anything at its `end`. The `active` place (by `key`
  or `href`) is raised and announced as the page; icons sit beside labels or over them
  (`layout="stacked"`); on a phone the places scroll sideways.
- **`TopBar`**: a thin strip with `start`, `center` and `end` (a clock, the company, the person and
  Sign out).
- **`TileGrid`**: a home page's places as tiles, each a large icon and its name; a tile's
  `description` is its tooltip and what screen readers say after the name.

```tsx
<TopBar start={<LiveClock format="dd/MM/yyyy HH:mm:ss" timeZone={zone} />} center="Acme Salon" end={<a href="/me">Ana</a>} />
<AppBar brand="Acme" href="/" active="/visits" layout="stacked" items={[
  { href: "/visits", label: "Visits", icon: <Icon src="/assets/places/visits.png" /> },
  { href: "/customers", label: "Customers", icon: "users" },
]} />
```

**Toasts.** `toast(message, tone)` or `toast(message, { tone, duration })`, from anywhere, shows a
few seconds' word over the page and gives back a function that dismisses it. Tones are `neutral`
(the default), `success`, `info`, `warning` and `destructive`; `duration` is 5,000 ms unless given
(`0`: until dismissed); it waits while hovered or focused. The shell shows them; an app without it
renders `<Toasts placement="bottom-end" />` once, and one given a `placement` takes over from the
shell's, so a toast never shows twice.

## Icons

Every piece that takes an icon takes one of the toolkit's by name or any element (`IconLike`):
`<Icon drawing={…} />` draws an app's own glyph (its paths in their box, `rule: "evenodd"` for holes
drawn that way), and `<Icon src="/assets/…png" />` an image file. `Avatar` shows a picture from
`https:`, the app's own origin, or one picked but not yet sent (a `blob:` or image `data:` address);
`initial={false}` draws an empty box when there's none.

```tsx
const GLYPH = {
  viewBox: "0 0 16 16",
  paths: [{ d: "M8 1a3.5 3.5 0 1 1 0 7…", rule: "evenodd" as const }],
};
<Button icon={<Icon drawing={GLYPH} />}>New customer</Button>;
```

## Shortcuts

`useShortcuts({ "Alt+1": focusItems, "Mod+S": save, Escape: { run: cancel, inFields: true } })`
binds keys to a screen's commands while it's shown. `Mod` is ⌘ on Apple's keyboards and Ctrl
elsewhere; letters and digits match the key pressed, so Alt+1 works whatever it types. A shortcut
waits while a modal dialog or a popover is open (unless the screen is in it: `within`), and while
someone types in a field unless it says `inFields`; a handled key's default is prevented. The
shell's own keys (⌘K, the palette) come first. `shortcutLabel("Alt+1")` says it as the keyboard does
(⌥1, or Alt+1).

## Printing

A printed page is the whole page, not its scrolling pane's screenful, and it leaves out what only
works on a screen: the shell's sidebar and menu, the toolkit's bars, toolbars, toasts, pages,
buttons, popovers, a `Page`'s header (unless `printHeader`), and a table's toolbar and tick column.
Links keep their words. `NoPrint` and `PrintOnly` mark an app's own parts. A printed document's own
layout (a receipt's width, an invoice's margins) is the one place an app writes CSS: its
`@media print` rules, beside the document.

```tsx
<NoPrint><Button icon="file" onClick={() => print()}>Print</Button></NoPrint>
<PrintOnly><Text size="sm">Printed {today}</Text></PrintOnly>
```

## PDFs on a server

`documentPdf(pages, { size })` draws a document as a PDF with no dependency and no React, so it runs
on a server (an e-mailed invoice): pages of things placed in points from each page's top left, text
(a font of Helvetica's four, a size, a colour, wrapped and aligned within a `width`), lines,
rectangles, images and vector barcodes. Sizes are `a4`, `a4-landscape`, `letter`, `receipt` (80 mm
wide, as tall as what's on it), or given. `textWidth` and `wrapText` measure with Helvetica's
widths, to lay out flowing text. Text outside Windows-1252 prints as "?". `copilotz/web/export` has
it, the table files and the barcodes' bars, without React.

```ts
import { documentPdf } from "copilotz/web/export";
const receipt = documentPdf([[
  { text: "Acme", x: 12, y: 12, width: 203, align: "center", font: "bold", size: 12 },
  { line: [12, 32, 215, 32] },
  { text: "Total", x: 12, y: 38 },
  { text: "12.50", x: 12, y: 38, width: 203, align: "right" },
  { barcode: "POS 12", x: 12, y: 60, width: 200, height: 40 },
]], { size: "receipt" });
```

## Barcodes

`Barcode` draws an SVG of whole-pixel bars. `width` sets the space available, `height` the bars'
height, and `caption` shows the value beneath. Its quiet margins are on by default. Code 128 packs
digit pairs where they fit (`set="B"` uses text throughout). Choose `format="code39"`,
`format="ean8"` or `format="ean13"` for the other symbols.

## Images and barcodes in a document

Prepare a logo once with `await pdfImage(bytesOrDataUrl)` and reuse it on any page. JPEG stays JPEG.
PNG supports 8-bit RGB, RGBA, grayscale, grayscale with alpha and indexed colours, including
interlaced images and packed 1-, 2- and 4-bit grayscale or palette samples. Transparency becomes a
PDF soft mask. The dimensions of the prepared image are pixels. The position and size on the page
are points.

```ts
import { barcodePng, documentPdf, pdfImage } from "copilotz/web/export";

export async function invoiceFiles(logoBytes: Uint8Array) {
  const logo = await pdfImage(logoBytes);
  const product = "5901234123457";
  const pdf = documentPdf([[
    { image: logo, x: 36, y: 36, width: 40, height: 40 * logo.height / logo.width },
    { text: "Invoice 1042", x: 92, y: 42, size: 16, font: "bold" },
    { barcode: product, format: "ean13", x: 36, y: 120, width: 240, height: 54, quiet: true },
  ]]);
  const label = await barcodePng(product, { format: "ean13", width: 300, height: 60 });
  return { pdf, label }; // application/pdf and image/png
}
```

EAN-8 takes seven digits and EAN-13 takes twelve, or give the complete number and its check digit is
verified. Keep leading zeros by passing a string. Code 39 accepts uppercase letters, digits, space
and `-.$/+%`. Set `check: true` for its Mod 43 character. `bars()` gives the same vector geometry
for other renderers. A product screen can print the complete EAN under its SVG:

```tsx
import { Barcode } from "copilotz/web";

<Barcode format="ean13" value="590123412345" width={300} height={60} caption />;
```

Barcode widths grow to fit at least one whole unit per module, including the requested quiet
margins. For example, Code 128 with `SKU-12345` and quiet margins grows from a requested 120 units
to 143. EAN-13 with quiet margins requires 113 pixels for PNG or 113 points for PDF. In
`documentPdf`, omitting the barcode's `width` uses the space from its `x` position to the page edge.
Printed bars extending beyond the page raise a `RangeError`. The blank quiet margins can extend
beyond its edges.

## A route's own page

A route that answers a page of its own (an import screen before anyone signs in, a password reset)
makes it with the toolkit too: `routePage(runtime, { title, body, status, headers, lang })` from
`copilotz/web/server` gives a `Response` whose head is the app page's (its theme, base, icons,
colour and fonts) and whose body is React made on the server, with the app's words. No script runs
on it, so its links and forms that post are what work. Its body is a `Page`, or a `Screen` when
nothing titles it (a sign-in's card, [above](#laying-out-a-screen)).

```tsx
"/import": (request, { runtime }) => routePage(runtime, {
  title: "Import",
  body: <Page title="Import"><Stack as="form" method="post"><Field label="File" htmlFor="file"><Input id="file" type="file" name="file" /></Field><Button type="submit" variant="primary">Import</Button></Stack></Page>,
}),
```

## Every piece's tokens

Each token is a CSS variable a theme sets without its `--`: sizes in `tokens`, colours in `light`
and `dark`. The default is Copilotz's look; one that names another token follows it.

### Spacing scale

| Token       | Default |
| ----------- | ------- |
| `space-xs`  | `4px`   |
| `space-sm`  | `8px`   |
| `space-md`  | `12px`  |
| `space-lg`  | `16px`  |
| `space-xl`  | `24px`  |
| `space-2xl` | `32px`  |

### Stack and Divider

| Token           | Default         |
| --------------- | --------------- |
| `divider-width` | `1px`           |
| `divider-color` | `var(--border)` |

### Toolbar

| Token                | Default       |
| -------------------- | ------------- |
| `toolbar-padding`    | `0`           |
| `toolbar-radius`     | `0`           |
| `toolbar-background` | `transparent` |
| `toolbar-grow-basis` | `200px`       |

### Split

| Token                  | Default |
| ---------------------- | ------- |
| `split-gap`            | `24px`  |
| `split-aside-width-sm` | `280px` |
| `split-aside-width`    | `340px` |
| `split-aside-width-lg` | `420px` |
| `split-sticky-top`     | `16px`  |

### ListGroup

| Token                     | Default            |
| ------------------------- | ------------------ |
| `list-group-border-width` | `1px`              |
| `list-group-radius`       | `var(--radius-lg)` |
| `list-group-row-height`   | `44px`             |
| `list-group-padding`      | `10px 14px`        |
| `list-group-font-size`    | `14px`             |
| `list-group-font-weight`  | `560`              |
| `list-group-end-padding`  | `14px`             |

### Screen

| Token            | Default |
| ---------------- | ------- |
| `screen-padding` | `24px`  |
| `screen-width`   | `420px` |
| `screen-gap`     | `24px`  |

### Text and Heading

| Token                    | Default               |
| ------------------------ | --------------------- |
| `text-size-xs`           | `12px`                |
| `text-size-sm`           | `13px`                |
| `text-size-md`           | `14.5px`              |
| `text-size-lg`           | `17px`                |
| `heading-font`           | `var(--font-display)` |
| `heading-font-weight`    | `650`                 |
| `heading-letter-spacing` | `-.015em`             |
| `heading-size-1`         | `28px`                |
| `heading-size-2`         | `21px`                |
| `heading-size-3`         | `17px`                |
| `heading-size-4`         | `15px`                |

### Page

| Token                    | Default               |
| ------------------------ | --------------------- |
| `page-width`             | `820px`               |
| `page-padding`           | `34px 24px 64px`      |
| `page-width-lg`          | `1040px`              |
| `page-title-font`        | `var(--font-display)` |
| `page-title-size`        | `28px`                |
| `page-title-weight`      | `680`                 |
| `page-description-width` | `560px`               |
| `page-body-gap`          | `20px`                |
| `page-padding-sm`        | `16px 16px 48px`      |
| `page-title-size-sm`     | `22px`                |

### Card

| Token                    | Default                   |
| ------------------------ | ------------------------- |
| `card-border-color`      | `var(--border)`           |
| `card-radius`            | `var(--radius-xl)`        |
| `card-shadow`            | `var(--shadow-sm)`        |
| `card-padding`           | `14px 16px`               |
| `card-padding-sm`        | `8px 10px`                |
| `card-head-padding`      | `10px 16px`               |
| `card-head-border`       | `1px solid var(--border)` |
| `card-head-background`   | `transparent`             |
| `card-head-foreground`   | `inherit`                 |
| `card-head-icon-color`   | `var(--muted-foreground)` |
| `card-title-font-family` | `var(--font-display)`     |
| `card-title-font-size`   | `15px`                    |
| `card-title-font-weight` | `600`                     |

### Button

| Token                             | Default                                                    |
| --------------------------------- | ---------------------------------------------------------- |
| `button-hover-mix`                | `var(--tone-toward)`                                       |
| `button-hover-amount`             | `var(--tone-amount)`                                       |
| `button-shadow`                   | `var(--shadow-sm)`                                         |
| `button-gap`                      | `8px`                                                      |
| `button-height`                   | `36px`                                                     |
| `button-padding`                  | `0 14px`                                                   |
| `button-radius`                   | `var(--radius-md)`                                         |
| `button-border-width`             | `1px`                                                      |
| `button-font-size`                | `14px`                                                     |
| `button-font-weight`              | `560`                                                      |
| `button-line-height`              | `1`                                                        |
| `button-active-transform`         | `translateY(.5px)`                                         |
| `button-active-shadow`            | `var(--button-shadow, var(--shadow-sm))`                   |
| `button-disabled-opacity`         | `.5`                                                       |
| `button-disabled-cursor`          | `default`                                                  |
| `button-height-xs`                | `26px`                                                     |
| `button-padding-xs`               | `0 8px`                                                    |
| `button-gap-xs`                   | `5px`                                                      |
| `button-font-size-xs`             | `12px`                                                     |
| `button-radius-xs`                | `var(--button-radius, var(--radius-md))`                   |
| `button-height-sm`                | `30px`                                                     |
| `button-padding-sm`               | `0 11px`                                                   |
| `button-gap-sm`                   | `6px`                                                      |
| `button-font-size-sm`             | `13px`                                                     |
| `button-radius-sm`                | `var(--button-radius, var(--radius-md))`                   |
| `button-height-lg`                | `44px`                                                     |
| `button-padding-lg`               | `0 18px`                                                   |
| `button-font-size-lg`             | `15px`                                                     |
| `button-radius-lg`                | `var(--button-radius, var(--radius-md))`                   |
| `button-outline-background`       | `var(--card)`                                              |
| `button-outline-foreground`       | `var(--card-foreground)`                                   |
| `button-outline-border`           | `var(--input)`                                             |
| `button-outline-hover-background` | `var(--muted)`                                             |
| `button-outline-hover-foreground` | `var(--button-outline-foreground, var(--card-foreground))` |
| `button-outline-hover-border`     | `var(--button-outline-border, var(--input))`               |
| `button-link-padding`             | `0`                                                        |
| `button-link-foreground`          | `var(--primary-text)`                                      |

### IconButton

| Token                   | Default            |
| ----------------------- | ------------------ |
| `icon-button-size`      | `34px`             |
| `icon-button-radius`    | `var(--radius-md)` |
| `icon-button-size-sm`   | `28px`             |
| `icon-button-radius-sm` | `var(--radius-sm)` |
| `icon-button-size-lg`   | `38px`             |

### Input

| Token                        | Default                                                              |
| ---------------------------- | -------------------------------------------------------------------- |
| `input-height`               | `40px`                                                               |
| `input-border-width`         | `1px`                                                                |
| `input-radius`               | `var(--radius-lg)`                                                   |
| `input-background`           | `var(--card)`                                                        |
| `input-focus-shadow`         | `0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent)`        |
| `input-radius-sm`            | `var(--radius-md)`                                                   |
| `input-gap`                  | `8px`                                                                |
| `input-padding`              | `0 12px`                                                             |
| `input-invalid-focus-shadow` | `0 0 0 4px color-mix(in oklab, var(--destructive) 14%, transparent)` |
| `input-disabled-opacity`     | `.55`                                                                |
| `input-disabled-background`  | `var(--input-background, var(--card))`                               |
| `input-font-size`            | `14.5px`                                                             |
| `input-placeholder`          | `var(--muted-foreground)`                                            |
| `input-placeholder-opacity`  | `.85`                                                                |
| `input-height-sm`            | `36px`                                                               |
| `input-padding-sm`           | `0 3px 0 10px`                                                       |
| `input-font-size-sm`         | `14px`                                                               |
| `input-height-lg`            | `44px`                                                               |
| `input-padding-lg`           | `0 14px`                                                             |
| `input-radius-lg`            | `${RADIUS}`                                                          |
| `input-font-size-lg`         | `15px`                                                               |
| `input-addon-min-width`      | `36px`                                                               |
| `input-addon-padding`        | `0 10px`                                                             |
| `input-addon-border-width`   | `var(--input-border-width, 1px)`                                     |
| `input-addon-background`     | `var(--muted)`                                                       |
| `input-addon-foreground`     | `var(--muted-foreground)`                                            |
| `input-addon-font-size`      | `14px`                                                               |

### Select

| Token                        | Default                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `select-min-width`           | `160px`                                                                                            |
| `select-height`              | `var(--input-height, 40px)`                                                                        |
| `select-border-width`        | `var(--input-border-width, 1px)`                                                                   |
| `select-radius`              | `var(--input-radius, var(--radius-lg))`                                                            |
| `select-background`          | `var(--input-background, var(--card))`                                                             |
| `select-font-size`           | `var(--input-font-size, 14.5px)`                                                                   |
| `select-height-sm`           | `var(--input-height-sm, 36px)`                                                                     |
| `select-font-size-sm`        | `var(--input-font-size-sm, 14px)`                                                                  |
| `select-padding`             | `0 36px 0 12px`                                                                                    |
| `select-focus-shadow`        | `var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))`           |
| `select-disabled-opacity`    | `var(--input-disabled-opacity, .55)`                                                               |
| `select-disabled-background` | `var(--input-disabled-background, var(--select-background, var(--input-background, var(--card))))` |
| `select-radius-sm`           | `var(--input-radius-sm, var(--radius-md))`                                                         |
| `select-height-lg`           | `var(--input-height-lg, 44px)`                                                                     |
| `select-font-size-lg`        | `var(--input-font-size-lg, 15px)`                                                                  |

### Textarea

| Token                          | Default                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `textarea-min-height`          | `84px`                                                                                               |
| `textarea-padding`             | `10px 12px`                                                                                          |
| `textarea-border-width`        | `var(--input-border-width, 1px)`                                                                     |
| `textarea-radius`              | `var(--input-radius, var(--radius-lg))`                                                              |
| `textarea-background`          | `var(--input-background, var(--card))`                                                               |
| `textarea-font-size`           | `var(--input-font-size, 14.5px)`                                                                     |
| `textarea-line-height`         | `1.5`                                                                                                |
| `textarea-focus-shadow`        | `var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))`             |
| `textarea-disabled-background` | `var(--input-disabled-background, var(--textarea-background, var(--input-background, var(--card))))` |

### Checkbox

| Token                   | Default                   |
| ----------------------- | ------------------------- |
| `checkbox-gap`          | `9px`                     |
| `checkbox-font-size`    | `14px`                    |
| `checkbox-size`         | `16px`                    |
| `checkbox-border-width` | `1.5px`                   |
| `checkbox-radius`       | `calc(var(--radius) / 3)` |

### Radio

| Token                | Default |
| -------------------- | ------- |
| `radio-gap`          | `9px`   |
| `radio-font-size`    | `14px`  |
| `radio-size`         | `16px`  |
| `radio-border-width` | `1.5px` |

### Field

| Token                     | Default                   |
| ------------------------- | ------------------------- |
| `field-gap`               | `7px`                     |
| `field-label-font-size`   | `13.5px`                  |
| `field-label-font-weight` | `600`                     |
| `field-label-color`       | `var(--foreground)`       |
| `field-required-color`    | `var(--destructive-text)` |
| `field-note-font-size`    | `12.5px`                  |
| `field-row-label-width`   | `30%`                     |
| `field-row-control-width` | `1fr`                     |
| `field-row-gap`           | `16px`                    |
| `field-row-label-offset`  | `0`                       |
| `field-row-label-align`   | `start`                   |

### Switch

| Token                     | Default                       |
| ------------------------- | ----------------------------- |
| `switch-width`            | `36px`                        |
| `switch-height`           | `20px`                        |
| `switch-padding`          | `2px`                         |
| `switch-border-width`     | `0`                           |
| `switch-border-color`     | `transparent`                 |
| `switch-radius`           | `9999px`                      |
| `switch-off-background`   | `var(--input)`                |
| `switch-off-foreground`   | `var(--secondary-foreground)` |
| `switch-font-size`        | `12px`                        |
| `switch-font-weight`      | `650`                         |
| `switch-width-sm`         | `30px`                        |
| `switch-height-sm`        | `16px`                        |
| `switch-width-lg`         | `44px`                        |
| `switch-height-lg`        | `24px`                        |
| `switch-on-background`    | `var(--primary)`              |
| `switch-on-foreground`    | `var(--primary-foreground)`   |
| `switch-thumb-aspect`     | `1`                           |
| `switch-thumb-width`      | `auto`                        |
| `switch-thumb-radius`     | `9999px`                      |
| `switch-thumb-background` | `var(--background)`           |
| `switch-thumb-shadow`     | `var(--shadow-sm)`            |
| `switch-word-padding`     | `7px`                         |
| `switch-disabled-opacity` | `.5`                          |

### TagsInput

| Token                           | Default                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `tags-input-gap`                | `6px`                                                                                    |
| `tags-input-min-height`         | `var(--input-height, 40px)`                                                              |
| `tags-input-padding`            | `5px 8px`                                                                                |
| `tags-input-border-width`       | `var(--input-border-width, 1px)`                                                         |
| `tags-input-border-color`       | `var(--input)`                                                                           |
| `tags-input-radius`             | `var(--input-radius, var(--radius-lg))`                                                  |
| `tags-input-background`         | `var(--input-background, var(--card))`                                                   |
| `tags-input-font-size`          | `var(--input-font-size, 14.5px)`                                                         |
| `tags-input-focus-border-color` | `var(--ring)`                                                                            |
| `tags-input-focus-shadow`       | `var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))` |
| `tag-padding`                   | `2px 4px 2px 9px`                                                                        |
| `tag-radius`                    | `var(--radius-full)`                                                                     |
| `tag-background`                | `var(--secondary)`                                                                       |
| `tag-foreground`                | `var(--secondary-foreground)`                                                            |
| `tag-font-size`                 | `13px`                                                                                   |
| `tag-font-weight`               | `560`                                                                                    |

### Picker and MultiPicker

| Token                                 | Default                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `picker-min-width`                    | `var(--select-min-width, 160px)`                                                         |
| `picker-height`                       | `var(--select-height, var(--input-height, 40px))`                                        |
| `picker-padding`                      | `0 10px 0 12px`                                                                          |
| `picker-border-width`                 | `var(--select-border-width, var(--input-border-width, 1px))`                             |
| `picker-border-color`                 | `var(--input)`                                                                           |
| `picker-radius`                       | `var(--select-radius, var(--input-radius, var(--radius-lg)))`                            |
| `picker-background`                   | `var(--select-background, var(--input-background, var(--card)))`                         |
| `picker-foreground`                   | `var(--foreground)`                                                                      |
| `picker-font-size`                    | `var(--select-font-size, var(--input-font-size, 14.5px))`                                |
| `picker-font-weight`                  | `400`                                                                                    |
| `picker-hover-background`             | `var(--picker-background, var(--card))`                                                  |
| `picker-hover-foreground`             | `var(--picker-foreground, var(--foreground))`                                            |
| `picker-open-border-color`            | `var(--ring)`                                                                            |
| `picker-open-background`              | `var(--picker-background, var(--card))`                                                  |
| `picker-open-foreground`              | `var(--picker-foreground, var(--foreground))`                                            |
| `picker-focus-shadow`                 | `var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))` |
| `picker-height-sm`                    | `var(--select-height-sm, var(--input-height-sm, 36px))`                                  |
| `picker-font-size-sm`                 | `var(--select-font-size-sm, var(--input-font-size-sm, 14px))`                            |
| `picker-caret-color`                  | `var(--muted-foreground)`                                                                |
| `picker-menu-min-width`               | `200px`                                                                                  |
| `picker-menu-max-width`               | `420px`                                                                                  |
| `picker-menu-padding`                 | `5px`                                                                                    |
| `picker-item-font-size`               | `14px`                                                                                   |
| `picker-search-height`                | `34px`                                                                                   |
| `picker-item-radius`                  | `var(--radius-md)`                                                                       |
| `picker-list-max-height`              | `320px`                                                                                  |
| `picker-item-height`                  | `34px`                                                                                   |
| `picker-item-padding`                 | `6px 10px`                                                                               |
| `picker-item-foreground`              | `var(--popover-foreground)`                                                              |
| `picker-item-hover-background`        | `var(--accent)`                                                                          |
| `picker-item-hover-foreground`        | `var(--accent-foreground)`                                                               |
| `picker-item-chosen-background`       | `transparent`                                                                            |
| `picker-item-chosen-foreground`       | `var(--picker-item-foreground, var(--popover-foreground))`                               |
| `picker-item-chosen-font-weight`      | `600`                                                                                    |
| `picker-item-chosen-hover-background` | `var(--picker-item-hover-background, var(--accent))`                                     |
| `picker-check-color`                  | `var(--primary-text)`                                                                    |

### Dialog

| Token                         | Default                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `dialog-width`                | `520px`                                                 |
| `dialog-border-color`         | `var(--border)`                                         |
| `dialog-radius`               | `var(--radius-2xl)`                                     |
| `dialog-shadow`               | `var(--shadow-lg)`                                      |
| `dialog-width-sm`             | `400px`                                                 |
| `dialog-width-lg`             | `760px`                                                 |
| `dialog-top`                  | `min(12vh, 96px)`                                       |
| `dialog-backdrop`             | `rgb(8 8 14 / .55)`                                     |
| `dialog-head-padding`         | `18px 14px 2px 22px`                                    |
| `dialog-head-border`          | `0`                                                     |
| `dialog-head-background`      | `transparent`                                           |
| `dialog-head-foreground`      | `inherit`                                               |
| `dialog-close-color`          | `var(--muted-foreground)`                               |
| `dialog-title-margin`         | `4px 0 0`                                               |
| `dialog-title-font-family`    | `var(--font-display)`                                   |
| `dialog-title-font-size`      | `17px`                                                  |
| `dialog-title-font-weight`    | `650`                                                   |
| `dialog-title-letter-spacing` | `-.01em`                                                |
| `dialog-body-padding`         | `14px 22px 22px`                                        |
| `dialog-foot-gap`             | `8px`                                                   |
| `dialog-foot-padding`         | `14px 18px`                                             |
| `dialog-foot-border`          | `1px solid var(--border)`                               |
| `dialog-foot-background`      | `color-mix(in oklab, var(--muted) 45%, var(--popover))` |

### Drawer

| Token          | Default |
| -------------- | ------- |
| `drawer-width` | `320px` |

### Tabs

| Token                             | Default                                  |
| --------------------------------- | ---------------------------------------- |
| `tabs-tab-height`                 | `34px`                                   |
| `tabs-tab-padding`                | `0 12px`                                 |
| `tabs-tab-radius`                 | `var(--radius-md)`                       |
| `tabs-tab-color`                  | `var(--muted-foreground)`                |
| `tabs-tab-font-size`              | `13.5px`                                 |
| `tabs-tab-font-weight`            | `560`                                    |
| `tabs-tab-hover-color`            | `var(--foreground)`                      |
| `tabs-segmented-padding`          | `3px`                                    |
| `tabs-segmented-radius`           | `var(--radius-lg)`                       |
| `tabs-segmented-background`       | `var(--muted)`                           |
| `tabs-segmented-shadow`           | `var(--shadow-sm)`                       |
| `tabs-line-gap`                   | `6px`                                    |
| `tabs-line-tab-height`            | `40px`                                   |
| `tabs-line-tab-padding`           | `0 6px`                                  |
| `tabs-line-tab-radius`            | `0`                                      |
| `tabs-line-tab-border-width`      | `0 0 2px`                                |
| `tabs-line-hover-background`      | `transparent`                            |
| `tabs-line-hover-border-color`    | `transparent`                            |
| `tabs-selected-color`             | `var(--foreground)`                      |
| `tabs-line-selected-background`   | `transparent`                            |
| `tabs-line-selected-border-color` | `transparent transparent var(--primary)` |

### Menu

| Token                        | Default                    |
| ---------------------------- | -------------------------- |
| `menu-min-width`             | `200px`                    |
| `menu-padding`               | `5px`                      |
| `menu-border-color`          | `var(--border)`            |
| `menu-radius`                | `var(--radius-lg)`         |
| `menu-shadow`                | `var(--shadow-md)`         |
| `menu-item-height`           | `34px`                     |
| `menu-item-padding`          | `6px 10px`                 |
| `menu-item-radius`           | `var(--radius-sm)`         |
| `menu-item-color`            | `inherit`                  |
| `menu-item-font-size`        | `14px`                     |
| `menu-item-hover-background` | `var(--accent)`            |
| `menu-item-hover-foreground` | `var(--accent-foreground)` |
| `menu-item-hover-icon`       | `var(--muted-foreground)`  |

### Popover

| Token                  | Default            |
| ---------------------- | ------------------ |
| `popover-width`        | `300px`            |
| `popover-padding`      | `6px`              |
| `popover-border-color` | `var(--border)`    |
| `popover-radius`       | `var(--radius-xl)` |
| `popover-shadow`       | `var(--shadow-lg)` |

### Autocomplete

| Token                             | Default                    |
| --------------------------------- | -------------------------- |
| `autocomplete-width`              | `380px`                    |
| `autocomplete-padding`            | `5px`                      |
| `autocomplete-border-color`       | `var(--border)`            |
| `autocomplete-radius`             | `var(--radius-xl)`         |
| `autocomplete-shadow`             | `var(--shadow-lg)`         |
| `autocomplete-option-height`      | `40px`                     |
| `autocomplete-option-padding`     | `5px 9px`                  |
| `autocomplete-option-radius`      | `var(--radius-md)`         |
| `autocomplete-active-background`  | `var(--accent)`            |
| `autocomplete-active-foreground`  | `var(--accent-foreground)` |
| `autocomplete-option-font-size`   | `14px`                     |
| `autocomplete-option-font-weight` | `560`                      |

### Tooltip

| Token                | Default             |
| -------------------- | ------------------- |
| `tooltip-max-width`  | `280px`             |
| `tooltip-padding`    | `5px 9px`           |
| `tooltip-radius`     | `var(--radius-sm)`  |
| `tooltip-background` | `var(--foreground)` |
| `tooltip-foreground` | `var(--background)` |
| `tooltip-font-size`  | `12.5px`            |

### Avatar

| Token                       | Default         |
| --------------------------- | --------------- |
| `avatar-empty-background`   | `var(--muted)`  |
| `avatar-empty-border-color` | `var(--border)` |

### Badge

| Token               | Default              |
| ------------------- | -------------------- |
| `badge-min-width`   | `20px`               |
| `badge-padding`     | `1px 7px`            |
| `badge-radius`      | `var(--radius-full)` |
| `badge-font-size`   | `11.5px`             |
| `badge-font-weight` | `600`                |

### Chip

| Token            | Default              |
| ---------------- | -------------------- |
| `chip-height`    | `30px`               |
| `chip-radius`    | `var(--radius-full)` |
| `chip-font-size` | `13px`               |

### Notice

| Token              | Default            |
| ------------------ | ------------------ |
| `notice-padding`   | `10px 12px`        |
| `notice-radius`    | `var(--radius-lg)` |
| `notice-font-size` | `14px`             |

### EmptyState

| Token                     | Default             |
| ------------------------- | ------------------- |
| `empty-state-icon-size`   | `56px`              |
| `empty-state-icon-radius` | `var(--radius-2xl)` |
| `empty-state-title-size`  | `20px`              |

### DetailList

| Token                     | Default                   |
| ------------------------- | ------------------------- |
| `detail-list-radius`      | `var(--radius-xl)`        |
| `detail-list-font-size`   | `14px`                    |
| `detail-list-label-width` | `clamp(7rem, 30%, 13rem)` |
| `detail-list-padding`     | `11px 16px`               |

### DataTable

| Token                       | Default                                              |
| --------------------------- | ---------------------------------------------------- |
| `table-cell-padding`        | `10px 12px`                                          |
| `table-border-color`        | `var(--border)`                                      |
| `table-font-size`           | `14px`                                               |
| `table-toolbar-gap`         | `8px`                                                |
| `table-toolbar-margin`      | `12px`                                               |
| `table-search-width`        | `220px`                                              |
| `table-radius`              | `var(--radius-lg)`                                   |
| `table-background`          | `var(--card)`                                        |
| `table-row-border-width`    | `1px`                                                |
| `table-column-border-width` | `0px`                                                |
| `table-head-background`     | `color-mix(in oklab, var(--muted) 70%, var(--card))` |
| `table-head-foreground`     | `var(--muted-foreground)`                            |
| `table-head-font-size`      | `12.5px`                                             |
| `table-head-font-weight`    | `600`                                                |
| `table-stripe`              | `transparent`                                        |
| `table-hover`               | `color-mix(in oklab, var(--muted) 55%, transparent)` |
| `table-selected`            | `var(--primary-soft)`                                |
| `table-detail-padding`      | `12px 16px`                                          |
| `table-empty-padding`       | `32px 12px`                                          |

### Pagination

| Token                           | Default                     |
| ------------------------------- | --------------------------- |
| `pagination-margin`             | `12px`                      |
| `pagination-font-size`          | `13px`                      |
| `pagination-gap`                | `2px`                       |
| `pagination-link-size`          | `32px`                      |
| `pagination-link-radius`        | `var(--radius-md)`          |
| `pagination-link-font-weight`   | `560`                       |
| `pagination-current-background` | `var(--primary)`            |
| `pagination-current-foreground` | `var(--primary-foreground)` |

### Calendar

| Token                          | Default                     |
| ------------------------------ | --------------------------- |
| `calendar-gap`                 | `20px`                      |
| `calendar-font-size`           | `13px`                      |
| `calendar-head-gap`            | `4px`                       |
| `calendar-title-font`          | `var(--font-display)`       |
| `calendar-title-size`          | `14px`                      |
| `calendar-title-weight`        | `650`                       |
| `calendar-day-size`            | `34px`                      |
| `calendar-day-radius`          | `var(--radius-md)`          |
| `calendar-nav-color`           | `var(--muted-foreground)`   |
| `calendar-hover-background`    | `var(--accent)`             |
| `calendar-hover-foreground`    | `var(--accent-foreground)`  |
| `calendar-row-gap`             | `2px`                       |
| `calendar-weekday-color`       | `var(--muted-foreground)`   |
| `calendar-weekday-size`        | `11.5px`                    |
| `calendar-today-ring`          | `var(--border)`             |
| `calendar-range-radius`        | `0`                         |
| `calendar-range-background`    | `var(--primary-soft)`       |
| `calendar-range-foreground`    | `var(--primary-text)`       |
| `calendar-selected-background` | `var(--primary)`            |
| `calendar-selected-foreground` | `var(--primary-foreground)` |
| `calendar-day-size-touch`      | `40px`                      |

### DatePicker and DateRangePicker

| Token                                  | Default                                                       |
| -------------------------------------- | ------------------------------------------------------------- |
| `date-picker-width`                    | `0`                                                           |
| `date-picker-height`                   | `40px`                                                        |
| `date-picker-padding`                  | `0 12px`                                                      |
| `date-picker-border-width`             | `1px`                                                         |
| `date-picker-border`                   | `var(--input)`                                                |
| `date-picker-radius`                   | `var(--radius-lg)`                                            |
| `date-picker-background`               | `var(--card)`                                                 |
| `date-picker-foreground`               | `var(--foreground)`                                           |
| `date-picker-font-size`                | `14.5px`                                                      |
| `date-picker-focus-border`             | `var(--ring)`                                                 |
| `date-picker-focus-shadow`             | `0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent)` |
| `date-picker-panel-padding`            | `12px`                                                        |
| `date-picker-panel-font-size`          | `13px`                                                        |
| `date-picker-panel-gap`                | `16px`                                                        |
| `date-picker-preset-gap`               | `2px`                                                         |
| `date-picker-presets-width`            | `180px`                                                       |
| `date-picker-preset-height`            | `32px`                                                        |
| `date-picker-preset-padding`           | `0 10px`                                                      |
| `date-picker-preset-radius`            | `var(--radius-md)`                                            |
| `date-picker-preset-font-size`         | `13.5px`                                                      |
| `date-picker-preset-active-background` | `var(--primary-soft)`                                         |
| `date-picker-preset-active-foreground` | `var(--primary-text)`                                         |
| `date-picker-foot-gap`                 | `12px`                                                        |
| `date-picker-fields-gap`               | `10px`                                                        |
| `date-picker-end-width`                | `9.5em`                                                       |
| `date-picker-height-touch`             | `44px`                                                        |
| `date-picker-preset-height-touch`      | `40px`                                                        |

### DateTimePicker

| Token                         | Default |
| ----------------------------- | ------- |
| `date-time-picker-gap`        | `6px`   |
| `date-time-picker-spin-width` | `3.6em` |

### LiveClock

| Token                | Default        |
| -------------------- | -------------- |
| `live-clock-numeric` | `tabular-nums` |

### FileInput

| Token                           | Default                       |
| ------------------------------- | ----------------------------- |
| `file-input-gap`                | `10px`                        |
| `file-input-padding`            | `4px 6px 4px 4px`             |
| `file-input-font-size`          | `14px`                        |
| `file-input-drop-border-color`  | `var(--primary)`              |
| `file-input-drop-background`    | `var(--primary-soft)`         |
| `file-input-button-height`      | `30px`                        |
| `file-input-button-padding`     | `0 11px`                      |
| `file-input-button-radius`      | `var(--radius-md)`            |
| `file-input-button-background`  | `var(--secondary)`            |
| `file-input-button-foreground`  | `var(--secondary-foreground)` |
| `file-input-button-font-weight` | `560`                         |

### RowsEditor

| Token                           | Default             |
| ------------------------------- | ------------------- |
| `rows-editor-gap`               | `12px`              |
| `rows-editor-label-width`       | `88px`              |
| `rows-editor-column-gap`        | `12px`              |
| `rows-editor-label-font-size`   | `13.5px`            |
| `rows-editor-label-font-weight` | `600`               |
| `rows-editor-label-color`       | `var(--foreground)` |
| `rows-editor-actions-offset`    | `6px`               |
| `rows-editor-error-font-size`   | `12.5px`            |

### AppBar

| Token                             | Default                                   |
| --------------------------------- | ----------------------------------------- |
| `appbar-background`               | `var(--background)`                       |
| `appbar-foreground`               | `var(--foreground)`                       |
| `appbar-border-width`             | `1px`                                     |
| `appbar-border-color`             | `var(--border)`                           |
| `appbar-shadow`                   | `none`                                    |
| `appbar-gap`                      | `16px`                                    |
| `appbar-max-width`                | `none`                                    |
| `appbar-height`                   | `56px`                                    |
| `appbar-padding-x`                | `16px`                                    |
| `appbar-brand-color`              | `currentColor`                            |
| `appbar-brand-font`               | `var(--font-display)`                     |
| `appbar-brand-font-size`          | `17px`                                    |
| `appbar-brand-font-weight`        | `650`                                     |
| `appbar-brand-hover-color`        | `var(--appbar-brand-color, currentColor)` |
| `appbar-items-justify`            | `flex-start`                              |
| `appbar-items-gap`                | `4px`                                     |
| `appbar-item-gap`                 | `8px`                                     |
| `appbar-item-height`              | `36px`                                    |
| `appbar-item-padding`             | `0 12px`                                  |
| `appbar-item-radius`              | `var(--radius-md)`                        |
| `appbar-item-color`               | `var(--muted-foreground)`                 |
| `appbar-item-font-size`           | `14px`                                    |
| `appbar-item-font-weight`         | `560`                                     |
| `appbar-item-hover-background`    | `var(--accent)`                           |
| `appbar-item-hover-color`         | `var(--accent-foreground)`                |
| `appbar-item-active-border-color` | `var(--border)`                           |
| `appbar-item-active-background`   | `var(--card)`                             |
| `appbar-item-active-color`        | `var(--card-foreground)`                  |
| `appbar-item-active-shadow`       | `var(--shadow-sm)`                        |
| `appbar-item-active-font-weight`  | `620`                                     |
| `appbar-icon-size`                | `18px`                                    |
| `appbar-icon-color`               | `var(--primary-text)`                     |
| `appbar-stacked-gap`              | `2px`                                     |
| `appbar-stacked-padding`          | `6px 10px`                                |
| `appbar-stacked-font-size`        | `12px`                                    |

### TopBar

| Token                       | Default                   |
| --------------------------- | ------------------------- |
| `topbar-background`         | `var(--muted)`            |
| `topbar-foreground`         | `var(--muted-foreground)` |
| `topbar-font-size`          | `12.5px`                  |
| `topbar-border-width`       | `1px`                     |
| `topbar-border-color`       | `var(--border)`           |
| `topbar-gap`                | `12px`                    |
| `topbar-max-width`          | `none`                    |
| `topbar-height`             | `28px`                    |
| `topbar-padding-y`          | `2px`                     |
| `topbar-padding-x`          | `16px`                    |
| `topbar-center-font-weight` | `620`                     |
| `topbar-center-color`       | `var(--foreground)`       |
| `topbar-link-color`         | `var(--primary-text)`     |

### TileGrid

| Token                   | Default                                     |
| ----------------------- | ------------------------------------------- |
| `tile-justify`          | `flex-start`                                |
| `tile-gap`              | `12px`                                      |
| `tile-label-gap`        | `10px`                                      |
| `tile-width`            | `132px`                                     |
| `tile-padding`          | `16px 10px 14px`                            |
| `tile-border-width`     | `1px`                                       |
| `tile-border-color`     | `var(--border)`                             |
| `tile-radius`           | `var(--radius-xl)`                          |
| `tile-background`       | `var(--card)`                               |
| `tile-color`            | `var(--card-foreground)`                    |
| `tile-shadow`           | `var(--shadow-sm)`                          |
| `tile-font-size`        | `14px`                                      |
| `tile-font-weight`      | `560`                                       |
| `tile-hover-background` | `var(--muted)`                              |
| `tile-hover-color`      | `var(--tile-color, var(--card-foreground))` |
| `tile-hover-decoration` | `none`                                      |
| `tile-icon-size`        | `40px`                                      |
| `tile-icon-radius`      | `0`                                         |
| `tile-icon-color`       | `var(--primary-text)`                       |

### Toasts

| Token                          | Default                     |
| ------------------------------ | --------------------------- |
| `toast-gap`                    | `8px`                       |
| `toast-width`                  | `360px`                     |
| `toast-offset`                 | `16px`                      |
| `toast-icon-gap`               | `10px`                      |
| `toast-padding`                | `12px 12px 12px 14px`       |
| `toast-border-width`           | `1px`                       |
| `toast-radius`                 | `var(--radius-lg)`          |
| `toast-shadow`                 | `var(--shadow-md)`          |
| `toast-font-size`              | `14px`                      |
| `toast-font-weight`            | `520`                       |
| `toast-line-height`            | `1.45`                      |
| `toast-icon-display`           | `inline-block`              |
| `toast-close-opacity`          | `.7`                        |
| `toast-neutral-background`     | `var(--popover)`            |
| `toast-neutral-foreground`     | `var(--popover-foreground)` |
| `toast-neutral-border`         | `var(--border)`             |
| `toast-neutral-icon`           | `var(--muted-foreground)`   |
| `toast-success-background`     | `var(--success-soft)`       |
| `toast-success-foreground`     | `var(--success-text)`       |
| `toast-success-border`         | `var(--success-border)`     |
| `toast-success-icon`           | `var(--success)`            |
| `toast-info-background`        | `var(--info-soft)`          |
| `toast-info-foreground`        | `var(--info-text)`          |
| `toast-info-border`            | `var(--info-border)`        |
| `toast-info-icon`              | `var(--info)`               |
| `toast-warning-background`     | `var(--warning-soft)`       |
| `toast-warning-foreground`     | `var(--warning-text)`       |
| `toast-warning-border`         | `var(--warning-border)`     |
| `toast-warning-icon`           | `var(--warning)`            |
| `toast-destructive-background` | `var(--destructive-soft)`   |
| `toast-destructive-foreground` | `var(--destructive-text)`   |
| `toast-destructive-border`     | `var(--destructive-border)` |
| `toast-destructive-icon`       | `var(--destructive)`        |

### Barcode

| Token                    | Default            |
| ------------------------ | ------------------ |
| `barcode-caption-gap`    | `2px`              |
| `barcode-padding`        | `0`                |
| `barcode-background`     | `#fff`             |
| `barcode-color`          | `#000`             |
| `barcode-radius`         | `0`                |
| `barcode-font`           | `var(--font-mono)` |
| `barcode-font-size`      | `12px`             |
| `barcode-letter-spacing` | `.08em`            |
