/**
 * The field a refusal is about: its `detail.field`, a dot path (`price`, `lines.0.qty`), as a
 * schema's refusal of a save and an Action's `failure` with a `detail` carry it; `undefined` for
 * any other error. A plain `Form` catches the refusal in its `onSubmit` and shows it under that
 * field (`RecordDialog` does it itself): `const field = refusedField(error); if (!field) throw
 * error;`, then that field's `error`.
 */
export function refusedField(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown } | null | undefined)?.detail;
  const field = detail && typeof detail === "object"
    ? (detail as { field?: unknown }).field
    : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
}
