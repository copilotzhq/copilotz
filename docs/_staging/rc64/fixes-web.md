# Web toolkit reference updates for rc.64

## Forms and dialogs

`EntityDialog.onSubmit(record, form, unset)` receives the values to save, the HTML form, and a map
of cleared fields. Each entry in `unset` has the value `true`. Clearing a previously populated
optional number puts its name in `unset` and omits it from `record`. An empty number that started
absent adds nothing. A nullable number that started as `null` keeps its value. An empty required
field shows its error before the handler runs. The record's `_id` belongs in the update filter.

```tsx
onSubmit={(record, _form, unset) =>
  customer
    ? customers.updateOne({ _id: customer._id }, { $set: record, $unset: unset })
    : customers.insertOne(record)}
```

The dialog stays busy from the first form part through the save. Cancel, Escape and backdrop
dismissal wait. Closing the dialog externally or changing its record discards pending form parts and
field errors. A save that already started can finish without closing the next dialog.

`Form` captures its part handlers and submit callback when submission starts. Its optional
`onSubmittingChange(busy, form)` reports progress. The third argument to the form's own
`onSubmit(values, form, signal)` is an `AbortSignal` that aborts when the form unmounts.

When the last `<Toasts />` host unmounts, unanswered `confirm()` calls resolve to `false`. An
operation already confirmed resolves with its outcome and runs once across a host handoff.

## Dates and times

A timed `DateRangePicker` accepts its displayed date and 24-hour clock in From and To, including
seconds. `parseDayTime` accepts the locale's decimal digits and the month names that `MMM` and
`MMMM` display.

`dateOfDayTime` uses the same rule in the process or browser's zone and an explicit IANA zone. A
skipped wall time moves forward by the length of the gap. A repeated wall time uses its earlier
instant. In New York, `2026-03-08 02:30` becomes 03:30 EDT (07:30 UTC), and `2026-11-01 01:30` uses
EDT (05:30 UTC).

## Exports

PDF column widths and alignments follow the visible titled columns in export order. When CSV uses
`quote: "needed"`, a row containing one empty field is written as `""`.

Barcode widths must fit at least one whole unit per module, including the requested quiet margins.
An undersized barcode raises a `RangeError` with its minimum width. EAN-13 with quiet margins
requires 113 pixels for PNG or 113 points for PDF.
