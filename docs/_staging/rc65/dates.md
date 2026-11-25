# rc.65 staging: dates (ranges to the second, typed day-times read back)

Not a page. The release commit copies (a) into `CHANGELOG.md` and (b), (c) into `AGENTS.md`.

## (a) CHANGELOG entry

Under `**New:**`:

- **Ranges to the second.** `DateRangePicker` with `seconds` takes each end to the second
  (`YYYY-MM-DD HH:mm:ss`; a preset runs from `00:00:00` to `23:59:59`). From and To each hold the
  end's day and time, typed or pasted whole. The field, the foot, From and To write the ends by one
  pattern, which reads them back: the app's `format` when it can be read back, or else the page
  language's own, with its clock (12-hour in American English) and a four-digit Gregorian year.
  What's typed is read when it's left, on Enter or on Apply, and only then moves an end; text that
  can't be read keeps Apply off. A typed end stays within `min` and `max`, and within 200 years of
  `today` (and 0000 to 9999) where they don't bound it, so a Buddhist or Persian year typed out of
  habit is refused.
- **Typed day-times read back.** `parseDayTime(text, pattern, locale)` reads what `formatPattern`
  writes with the same pattern, in any language, for years 0000 to 9999: any case by the language's
  rules and any spacing, names without their final dot, the language's digits, seconds left out. It
  refuses what isn't one real day and time (`31/02`, 13 PM), a two-digit year (the century is never
  guessed), and text that could be two day-times. `patternProblem` says why a pattern can't be read
  back (`yy`, `yyyy/dM`, Chinese `dMMM`, Persian month names, Thai month names, which are Julian
  before 1582), and `dayTimePattern(locale)` is the language's own.
- **A wall-clock time's moment.** `dateOfDayTime(value, timeZone)` is the `Date` a day-time names in
  a time zone, by Temporal's "compatible" rule: a time the clocks skip moves forward by the gap, and
  a time they repeat is its first pass, as `new Date(…)` does in the page's zone. With no zone, the
  page's clock is read as `Date` reads it (`TZ=GMT+3` is three hours behind UTC).

Under `**Fixed:**`:

- **From and To are read when they're done, here since rc.54.** In `DateRangePicker`, each keystroke
  that made a valid day moved the range, and Apply took the moved end: typing `2` on the way to `20`
  in To moved From to the 2nd. From and To are now read only when they're left, on Enter, or on
  Apply. Text that isn't a day stays as typed, marked, and Apply is off until it's put right. And
  with a first day picked, To is empty until the second is: where rc.54 couldn't read an end's text
  back (Arabic's short date, a function `format`), it kept showing the old end.

Under `**Docs:**`:

- The toolkit guide has "Date ranges with seconds" and "Reading typed dates and times".

Under `**Upgrading:**`:

- Nothing else changes for existing date pickers: without `seconds`, `DateRangePicker` draws as in
  rc.64, and only reads From and To when they're done (Fixed, above). `DatePicker`,
  `DateTimePicker`, `parsePattern` and `parseDay` are unchanged.

## (b) AGENTS.md text

Section **"A business app's web front end"**, "Short recipes": replace the bullet that starts
`**Date, date-time and date-range fields:**` with:

```markdown
- **Date, date-time and date-range fields:** days are `YYYY-MM-DD` and times `YYYY-MM-DD HH:mm` or
  `HH:mm:ss`, the app's clock time with no zone, never ISO timestamps. `todayIn(timeZone)` and
  `nowIn(timeZone)` in the app's zone, `format` patterns from its settings. `DatePicker`;
  `DateTimePicker` keeps a value's seconds until its time changes (`seconds` shows them);
  `DateRangePicker` has `presets` (or `rangePresets(…)`), typed From and To, `time` for ends with a
  time of day, and `seconds` for ends to the second, typed whole and read back by the pattern
  they're shown in. Typed or pasted text: `parseDayTime(text, pattern, locale)`, with
  `patternProblem(pattern)` in a test for the app's patterns. To compare stored timestamps with a
  range, `dateOfDayTime(end, timeZone)` is each end's moment in the app's zone.
```

Same section, "Common mistakes": replace the bullet that starts `Dates in the browser's locale`
with:

```markdown
- Dates in the browser's locale (`toLocaleString`, `<input type="date">`) or as ISO timestamps given
  to a picker; a function `format` on a range people type into (it can't be read back: use a
  pattern); a pattern with a two-digit year (`yy`) or fields that run together (`yyyy/dM`) where
  people type (`patternProblem` says which); a record's date-time saved unchanged without its
  seconds.
```

## (c) "Find it" lines

Section **"Find it"**, group **"Screens and dates"**, after the `DatePicker`, `DateTimePicker`,
`DateRangePicker` line:

```markdown
- Filter a report by a date range to the second → `DateRangePicker seconds` →
  [Date ranges with seconds](docs/guides/the-web-toolkit.md#date-ranges-with-seconds).
- Read and check a typed or pasted date-time → `parseDayTime`, `patternProblem`, `dayTimePattern` →
  [Reading typed dates and times](docs/guides/the-web-toolkit.md#reading-typed-dates-and-times).
- Turn a local wall-clock time into an instant in a time zone → `dateOfDayTime` →
  [Reading typed dates and times](docs/guides/the-web-toolkit.md#reading-typed-dates-and-times).
```
