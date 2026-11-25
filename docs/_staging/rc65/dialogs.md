# rc.65 staging: confirmations, record dialogs and refused fields

For whoever assembles rc.65's `CHANGELOG.md` and `AGENTS.md`. Nothing here ships: `docs/_staging/`
stays out of the package.

## (a) CHANGELOG entry

Under `## Unreleased`, in **New:**

```markdown
- **Asking before going on.** `useConfirm()` asks from a handler: draw its `dialog` once, then
  `await confirm({ title, message, danger, onConfirm, toast })`, `true` once confirmed and done,
  `false` when cancelled. `ConfirmDialog` is the same question as a component, for a dialog View at
  an address; one element is one question, so give it a `key`. An async `onConfirm` keeps the dialog
  busy, and a failure says why in it and stays to try again. With `danger`, the button is
  destructive and Cancel has the focus. The questions belong to the component that asks: when it
  goes, one still waiting is answered no and never shows again.
- **A record in a dialog.** `RecordDialog` adds or edits one record: a `Dialog` holding a `Form`,
  its fields bound to a draft by `form.text`, `form.number`, `form.checked`, `form.radio`,
  `form.value` and `form.list`. Save gives `onSave` a `RecordChange`: a new record's `values`, or a
  stored one's `set`, `unset` and MongoDB `update`, for `insertOne` or `updateOne`. An untouched
  field is never in it. A text, number or choice emptied is an `unset`, and a list emptied is `[]`.
  A save runs to its end on the record it started on. rc.64's planned `EntityDialog` shipped as
  `RecordDialog`.
- **Refused fields.** A save refused by its field (`detail.field`) shows under the `Field` whose
  `error` is `form.error(name)`, in the words `errors` gives for it. `refusedField(error)` reads the
  field for a plain `Form`.
- **Busy dialogs.** `Dialog` takes `busy` (Escape, the backdrop and its × wait), `isolated` (it
  answers only its own close and Escape, not a dialog's shown inside it), `role` (an `alertdialog`)
  and `aria-describedby`. The confirmations and record dialogs are isolated always: dismissing one
  never closes the `Dialog` or `Drawer` it's shown in.
- **Words:** `toolkit.confirm`, `toolkit.delete` and `toolkit.notDone`, in English and Brazilian
  Portuguese.
- **Known limits** of the confirmations and the record dialog
  ([the toolkit guide](docs/guides/the-web-toolkit.md#known-limits)):
  - What's typed while the save runs isn't in it; on success the dialog closes.
  - A part's value wins over an edit of the same field, even one typed while the part runs.
  - A field made invalid while a part runs isn't checked again; the schema refuses it.
  - A path through a list or a map that isn't there yet (`lines.0.qty`) makes an object: give it a
    value in `defaults` or the record, or set it whole with `form.set`.
  - Don't put a `RecordDialog` inside a form, or a form in its fields: a submit goes to every form
    around it.
  - Questions show one at a time: don't await another `confirm()` inside `onConfirm`.
  - Draw `useConfirm`'s `{dialog}` once.
  - If a browser closes a busy confirmation anyway, its answer comes when the operation ends. If it
    closes a dialog just as its operation ends, the outcome may show in the closed dialog.
  - A `ConfirmDialog` given a new `key` while open gives the focus back to the page, not to the
    first opener.
  - An app's own `Dialog` closing still closes an app's own dialog or `Drawer` around it, as in
    rc.64, unless the outer one is an `isolated` `Dialog`.
```

## (b) AGENTS.md text

### "Find it", under **Screens and dates**, after "Build a form with labelled inputs"

```markdown
- Ask before deleting → `useConfirm`, `ConfirmDialog` →
  [Confirming an action](docs/guides/the-web-toolkit.md#confirming-an-action).
- Add or edit a record in a dialog with field errors → `RecordDialog`, `RecordChange` →
  [A record in a dialog](docs/guides/the-web-toolkit.md#a-record-in-a-dialog).
- Show a server's refused field under its input → `form.error(name)`, `refusedField` →
  [Showing a refused field](docs/guides/the-web-toolkit.md#showing-a-refused-field).
```

### "A business app's web front end": "Views read; handlers save, or call Actions."

At the end of the bullet "**Validation errors come from where the write is checked.**", after "A
dialog closes only after the save, or the Action, answered.", add:

```markdown
In a `RecordDialog`, each `Field`'s `error` is `form.error(name)` and `errors` gives the words by
field; with a plain `Form`, `refusedField(error)` reads the field.
```

### "A business app's web front end": "The pieces, by job"

Replace:

```markdown
- **Actions and overlays:** `Button`, `IconButton`, `Menu`, `Popover`, `Dialog`, `Drawer`,
  `Tooltip`, `toast` and `Toasts`.
```

With:

```markdown
- **Actions and overlays:** `Button`, `IconButton`, `Menu`, `Popover`, `Dialog`, `Drawer`,
  `Tooltip`, `toast` and `Toasts`; `useConfirm` and `ConfirmDialog` to ask first; `RecordDialog` to
  add or edit a record.
```

### "A business app's web front end": "Short recipes"

Replace:

```markdown
- **A create or edit form in a dialog:** the screen shows
  `ctx.show("dialog:customer", { _id, back })` when its address names one (`/customers/new`,
  `/customers/<id>`). The dialog's View reads the record and returns a component: a `Dialog`
  (`placement="top"`) around a `Form` of `Field layout="row"`s, Save in its footer submitting the
  form by its id (`form="customer"`). `onSubmit` writes the record (`insertOne` for a new one,
  `updateOne({ _id }, fields)` for an edit), then `toast()` and `go(back)`.
```

With:

```markdown
- **A create or edit form in a dialog:** the screen shows
  `ctx.show("dialog:customer", { _id, back })` when its address names one (`/customers/new`,
  `/customers/<id>`). The dialog's View reads the record and returns a `RecordDialog` (`record`, or
  `defaults` for a new one) whose children are `(form) => <Field … error={form.error("name")}>`s,
  each control spread with its binder (`{...form.text("name")}`, `form.number`, `form.value` for a
  picker). `onSave(change)` writes it: `insertOne(change.values)` for a new one,
  `updateOne({ _id: change._id }, change.update)` for an edit, which holds only what changed (a
  field emptied is an `$unset`). `toast` and `onClose={() => go(back)}` finish it. Call `ctx.show`
  in the View's body, not in the function.
- **A delete that asks first:** in a component of `lib/web/` (a row's Delete),
  `const [dialog, confirm] = useConfirm()`, draw `{dialog}`, and on click
  `confirm({ title, danger: true, toast, onConfirm: () => collection.deleteOne({ _id }) })`. As a
  dialog View, `<ConfirmDialog key={_id} … onClose={() => go(back)} />`.
```

### "Common mistakes"

Add to the list:

```markdown
- A delete with no question, or `window.confirm`; a record dialog that saves the whole record
  (`$set` of every field) instead of `change.update`, writing back fields nobody touched; a
  `ConfirmDialog` reused for another record without a new `key`.
```

## (c) "Find it" lines

- Ask before deleting → `useConfirm`, `ConfirmDialog` →
  `docs/guides/the-web-toolkit.md#confirming-an-action`
- Add or edit a record in a dialog with field errors → `RecordDialog`, `RecordChange` →
  `docs/guides/the-web-toolkit.md#a-record-in-a-dialog`
- Show a server's refused field under its input → `form.error(name)`, `refusedField` →
  `docs/guides/the-web-toolkit.md#showing-a-refused-field`
