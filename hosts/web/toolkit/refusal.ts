/**
 * The field a refusal is about, for a form that shows it under that field's input. A schema's
 * refusal of a save names it in `detail.field`, and so does an Action's `failure` given a
 * `detail` (`Object.assign(failure("invalid", "Give the name.", { public: true }), { detail:
 * { field: "name" } })`). `RecordDialog` does this itself (`form.error(name)`); a plain `Form`
 * catches the refusal in its `onSubmit`:
 *
 * ```tsx
 * <Form onSubmit={async (_values, form) => {
 *   try {
 *     await save(new FormData(form));
 *   } catch (error) {
 *     const field = refusedField(error);
 *     if (!field) throw error; // the form says it at its top
 *     setRefused({ field, words: SAYS[field] ?? (error as Error).message });
 *   }
 * }}>
 * ```
 */

/**
 * The field a refusal is about: its `detail.field`, a dot path (`price`, `lines.0.qty`), as a
 * schema's refusal of a save and an Action's `failure` with a `detail` carry it. `undefined`
 * for any other error.
 */
export function refusedField(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown } | null | undefined)?.detail;
  const field = detail && typeof detail === "object"
    ? (detail as { field?: unknown }).field
    : undefined;
  return typeof field === "string" && field !== "" ? field : undefined;
}
