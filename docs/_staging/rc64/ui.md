# rc.64 staging: shared dialogs, date ranges with seconds, shared UI in apps

Stream `rc64/ui`. For the integrator: (a) goes under `## Unreleased` in `CHANGELOG.md`, (b) into
`AGENTS.md`, (c) into the capability index.

## (a) CHANGELOG entry

```markdown
**New:**

- **`ConfirmDialog` and `confirm()` ask before going on** (`copilotz/web`): a question, what follows
  from it, Cancel and a button that confirms; `danger` makes it a destructive one, for a delete,
  with Cancel focused so Enter never deletes. An async `onConfirm` keeps it open and busy; a failure
  shows its words in it and keeps it open; done, it closes, with a `toast` if given.
  `confirm(options)` asks the same from anywhere, with no state, and resolves `true` or `false`: the
  page's `<Toasts />` shows it.
- **`EntityDialog`, a record in a dialog,** to add or change it: a `Dialog` holding a `Form`, with
  Cancel and Save. It starts from the record's `values`; its fields are data (`fields`: `text`,
  `email`, `number`, `textarea`, `select`, `checkbox`, `date`, `datetime`, or `render`) or children
  (`Field`s, or a function of the record and `set`). A needed field left empty is said before
  anything is sent; `onSubmit` gets the record less its `_id`, for a plain save or an Action; a
  refusal shows under its field, in the words `errors` gives; done, it closes with a `toast`.
- **A save's refusal shows under its field.** A `Form` puts a failure that names a field
  (`detail.field`: a schema's refusal, or an Action's `failure` with a `detail`) under the `Field`
  of that `name`, or of the field it's part of, and at its top when none has it. `errors` gives
  people's words by field. A `Field`'s `name` goes to a control drawn as a function.
- **`Dialog` `busy`** keeps it open while something it started runs (Escape, the backdrop and its
  close button wait), and `role="alertdialog"` marks one that asks. A modal's focus goes to what's
  marked `data-autofocus` first.

**Dates:**

- **Date ranges to the second:** `DateRangePicker` `seconds` gives each end a seconds field, and
  ends `YYYY-MM-DD HH:mm:ss` (a preset runs from `00:00:00` to `23:59:59`). With a time, From and To
  also read a whole day and time typed in the field's format, and `format` may be the app's day-time
  pattern (`dd/MM/yyyy HH:mm:ss`), which writes each end whole.
- **Typed day-times read back:** `parseDayTime(text, pattern, locale)` reads what `formatPattern`
  writes: day and month in the pattern's order, a 24-hour or a 12-hour clock (AM and PM in the
  language's words or English's), seconds typed or left out. An impossible day or time is
  `undefined`. With no pattern, it reads the language's short date and time.
  `dateOfDayTime(value, timeZone)` is the moment a day-time names in a time zone, as a `Date`.
- **A pattern's words read loosely:** `parseDay` and `parsePattern` take any spaces and a comma or
  none between a pattern's parts, and `yy` takes a whole year typed too (`11/16/2026` by `M/d/yy`).

**Words:** `toolkit.confirm`, `toolkit.delete`, `toolkit.notDone` and `toolkit.fillIn`, in English
and Brazilian Portuguese.

**Docs:**

- **The web toolkit** has "Confirming an action", "A record in a dialog", "Date ranges with seconds"
  and "Reading typed dates and times", and a save's refusal by field among its forms.
- **A business app's screens:** an app's own components (a status badge, a table preset, a form
  section) live in `lib/`, the plugin's or the app's beside `plugins/`, never read as declarations;
  Views stay one per file. Its customer's and visit's dialogs are `EntityDialog`s, and a delete asks
  first, with `confirm()` and a `ConfirmDialog` View.
```

## (b) AGENTS.md text

All in the section **"A business app's web front end"**.

**1. Under "Files and names.", replace the first bullet** ("**One View per file**, in
`plugins/<name>/views/web/`, with the React components it draws beside it. … go in
`views/web/components/`, made of the toolkit's pieces.") with these two:

```markdown
- **One View per file**, in `plugins/<name>/views/web/`. `web.tsx` only names the plugin's Views, as
  `mod.ts` assembles the server side. Not one big `web.tsx`, and never several Views in a file.
- **React components live in `lib/`:** the plugin's `lib/web/` for what its screens share (and a
  component one View draws, such as one holding `useShortcuts`), and the app's own `lib/web/`,
  beside `plugins/`, for what every plugin's screens share: a status badge, a table preset, a form
  section. They're made of the toolkit's pieces and leave the look to the theme. `lib/` is never
  read as declarations, and any plugin may import the app's `lib/` (`boundaries` checks imports
  between plugins only).
```

**2. Under "Views read; handlers save, or call Actions.", in the bullet "Validation errors come from
where the write is checked.", replace** "and a `Form` whose `onSubmit` throws puts it in that
`Field`'s `error`." **with:**

```markdown
and a `Form` whose `onSubmit` throws shows it under the `Field` of that `name`
(`<Field
name="price">`), in the words its `errors` gives by field (`EntityDialog` does it all).
```

**3. In "The pieces, by job:", replace the "Actions and overlays" line with these two:**

```markdown
- **Actions and overlays:** `Button`, `IconButton`, `Menu`, `Popover`, `Dialog`, `Drawer`,
  `Tooltip`, `toast` and `Toasts`.
- **Dialogs, made:** `ConfirmDialog` and `confirm()` (ask before an action: a delete), and
  `EntityDialog` (a record's form in a dialog, to add or change it).
```

and add `parseDayTime` and `dateOfDayTime` to the end of the **Fields** line:

```markdown
- **Fields:** `Form`, `Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `Radio`, `Switch`,
  `Picker`, `MultiPicker`, `Autocomplete`, `TagsInput`, `FileInput`, `RowsEditor`, `DatePicker`,
  `DateRangePicker`, `DateTimePicker`, `TimeFields`; typed day-times read back with `parseDayTime`.
```

**4. In "Short recipes", replace the "A create or edit form in a dialog" recipe with these two:**

```markdown
- **A create or edit form in a dialog:** the screen shows
  `ctx.show("dialog:customer", { _id, back })` when its address names one (`/customers/new`,
  `/customers/<id>`). The dialog's View reads the record and returns an `EntityDialog`: `title`,
  `values` (the record, or a new one's defaults), `fields` as data
  (`{ name, label, type, required }`, `type` one of `text`, `email`, `number`, `textarea`, `select`,
  `checkbox`, `date`, `datetime`…) or `Field`s with a `name` as children, `errors` (people's words
  by field), `onSubmit` (`insertOne(record)`, or `updateOne({ _id }, record)`; an Action with
  `ctx.call`), `toast` and `onClose={() => go(back)}`. It keeps what's typed, says a needed field
  left empty, shows a refusal under its field, and closes once the save answered.
- **A delete that asks first:**
  `confirm({ title, message, danger: true, toast, onConfirm: () =>
  ctx.db.collection("customer").deleteOne({ _id }) })`
  from a row's button or a table's `actions`: it shows where `<Toasts />` is, and resolves `true` or
  `false`. As a `dialog:` View at an address, return a `ConfirmDialog` with the same props and
  `onClose`. While `onConfirm` runs it's busy; a failure stays in it, with its words.
```

**5. In "Short recipes", at the end of "Date, date-time and date-range fields", add:**

```markdown
`DateRangePicker` `seconds` takes the ends to the second (`00:00:00` to `23:59:59` for a preset),
and its `format` may be the app's day-time pattern. `parseDayTime(text, pattern)` reads typed
day-time text back (`undefined` when it isn't one); `dateOfDayTime(value, timeZone)` is its moment,
as a `Date`.
```

**6. In "Common mistakes", replace the first bullet's first sentence** ("A UI kit and stylesheets of
the app's own, inline styles for looks, or overrides of `.copilotz-*`, instead of the toolkit and
the theme.") **with:**

```markdown
- Stylesheets of the app's own, inline styles for looks, or overrides of `.copilotz-*`, instead of
  the toolkit and the theme; components several screens share copied into each, instead of one in
  `lib/`; a confirm, delete or record dialog written again for each screen, instead of `confirm()`,
  `ConfirmDialog` and `EntityDialog`.
```

(keep the rest of that bullet, "Hand-made `<table>`s of fields … `useFormSubmit`).", as it is), and
**add to the last bullet** ("A workaround copied from an older release: rc.54 has …"):

```markdown
rc.64 has `ConfirmDialog` and `confirm()`, `EntityDialog`, a refusal under its `Field` (`name`),
date ranges to the second and `parseDayTime`.
```

## (c) Capability index

- ask before deleting, or before any action → `ConfirmDialog`, `confirm()` →
  `docs/guides/the-web-toolkit.md#confirming-an-action`
- delete a row from a list, asking first → `confirm({ danger, onConfirm })` →
  `docs/guides/a-business-apps-screens.md#deleting-after-asking`
- add/edit a record in a dialog with field errors → `EntityDialog` →
  `docs/guides/the-web-toolkit.md#a-record-in-a-dialog`
- a record's form as data (text, number, select, checkbox, date, date-time) → `EntityDialog`
  `fields` (`EntityField`) → `docs/guides/the-web-toolkit.md#a-record-in-a-dialog`
- show a save's refusal (schema or Action) under its field → `Field` `name`, `Form` `errors` →
  `docs/guides/the-web-toolkit.md#forms`
- keep a dialog open while its save runs → `Dialog` `busy` → `docs/guides/the-web-toolkit.md#forms`
- a date range to the second → `DateRangePicker` `seconds` →
  `docs/guides/the-web-toolkit.md#date-ranges-with-seconds`
- read typed date-time text (day/month order, 12 h or 24 h, seconds) → `parseDayTime` →
  `docs/guides/the-web-toolkit.md#reading-typed-dates-and-times`
- a day-time as a `Date` or an ISO timestamp, in the app's time zone → `dateOfDayTime` →
  `docs/guides/the-web-toolkit.md#reading-typed-dates-and-times`
- UI components several screens or plugins share → `lib/web/` (the plugin's, or the app's) →
  `docs/guides/a-business-apps-screens.md#shared-ui-an-apps-own-components`
