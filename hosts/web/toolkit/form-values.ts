/**
 * A record's values from a form, as `EntityDialog` saves them: what the
 * form's named controls hold, typed as a record keeps them (text, numbers,
 * yes or no, lists), and its own fields' values made ready for a save
 * (numbers typed as text become numbers; a required field left empty is
 * said by name, before anything is sent).
 */

/** A form control, as `formValues` reads it: what `form.elements` holds. */
type Element = {
  name?: string;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  valueAsNumber?: number;
  selectedOptions?: ArrayLike<{ value: string }>;
};

/** Controls that hold nothing a record keeps. */
const SKIPPED = new Set(["submit", "button", "reset", "image", "file", "fieldset", "output"]);

/**
 * What a form's named controls hold, as a record keeps it: text as a string; a number field as a
 * number (`undefined` when cleared); a checkbox as `true` or `false`; the chosen radio's value;
 * a multiple select, or several controls of one name, as a list. Buttons, files and disabled
 * controls are left out.
 */
export function formValues(form: { elements: ArrayLike<unknown> }): Record<string, unknown> {
  const controls = (Array.from(form.elements) as Element[]).filter((c) =>
    !!c.name && !c.disabled && !SKIPPED.has((c.type ?? "").toLowerCase())
  );
  const count = new Map<string, number>();
  for (const c of controls) count.set(c.name!, (count.get(c.name!) ?? 0) + 1);
  const values: Record<string, unknown> = {};
  for (const c of controls) {
    const name = c.name!;
    const type = (c.type ?? "").toLowerCase();
    const listed = (count.get(name) ?? 0) > 1 && type !== "radio";
    if (listed && !(name in values)) values[name] = [];
    let value: unknown;
    if (type === "radio") {
      if (!c.checked) continue;
      value = c.value ?? "";
    } else if (type === "checkbox") {
      if (listed && !c.checked) continue;
      value = listed ? c.value ?? "" : !!c.checked;
    } else if (type === "number" || type === "range") {
      value = Number.isNaN(c.valueAsNumber) ? undefined : c.valueAsNumber;
      if (listed && value === undefined) continue;
    } else if (type === "select-multiple") {
      value = Array.from(c.selectedOptions ?? [], (option) => option.value);
    } else value = c.value ?? "";
    if (listed) (values[name] as unknown[]).push(value);
    else values[name] = value;
  }
  return values;
}

/** A field of a record's form, as far as its value goes: its name, its kind, whether it's needed. */
export type FieldShape = { name: string; type?: string; required?: boolean };

/** Whether a value is nothing at all: none, empty text, an empty list. */
const empty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);

/**
 * A record's values made ready for its save, by its form's fields: a number field's text is a
 * number (an empty one left out); a required field left empty is in `missing`, by name, so the
 * form says so before anything is sent (a checkbox is never empty). `_id` is left out: a save
 * names the record in its filter.
 */
export function entityValues(
  fields: FieldShape[],
  values: Record<string, unknown>,
  initial: Record<string, unknown> = {},
): { values: Record<string, unknown>; missing: string[]; unset: Record<string, true> } {
  const ready = { ...values };
  delete ready._id;
  for (const field of fields) {
    const value = ready[field.name];
    if (field.type !== "number" || typeof value !== "string") continue;
    const number = Number(value);
    // Empty is none; text that isn't a number stays, for the schema to refuse by its field.
    if (value.trim() === "") ready[field.name] = undefined;
    else if (!Number.isNaN(number)) ready[field.name] = number;
  }
  const unset: Record<string, true> = {};
  for (const [name, value] of Object.entries(ready)) {
    if (value !== undefined) continue;
    delete ready[name];
    if (Object.hasOwn(initial, name)) {
      if (initial[name] === null) ready[name] = null;
      else if (initial[name] !== undefined) unset[name] = true;
    }
  }
  const missing = fields.filter((f) => f.required && f.type !== "checkbox" && empty(ready[f.name]))
    .map((f) => f.name);
  return { values: ready, missing, unset };
}
