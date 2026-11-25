/**
 * A record in a dialog, to add or to change: a `Dialog` holding a `Form`,
 * with Cancel and Save in its footer. It starts from the record's `values`
 * (a new one's defaults), and its fields are data (`fields`: a label, a
 * kind, whether it's needed), children (`Field`s, or a function of the
 * record as the form has it and `set`), or both: the fields first.
 *
 * On Save (or Enter in a field), a required field left empty is said under
 * it; then `onSubmit` gets the record as the form leaves it: `values`, its
 * fields' changes, every named control in it (text as a string, a number as
 * a number, a checkbox as `true` or `false`) and what a `useFormSubmit` part
 * hands up, less its `_id` (a save names the record in its filter). It's a
 * plain save (`ctx.db.collection(name).insertOne(…)`, `updateOne({ _id },
 * …)`) or an Action (`ctx.call(…)`). While it runs, Save is busy and the
 * dialog stays open. Once it's done, a `toast` says so if given, and the
 * dialog closes (`onClose`); if it returns `false`, it stays open.
 *
 * A failure about one field (a schema's refusal names it in `detail.field`,
 * an Action's `failure` with a `detail`) shows under that field, in the
 * words `errors` gives for it (a schema's are for developers), or its own;
 * any other failure shows at the form's top. Escape, the backdrop and
 * Cancel close it, except while it saves; focus goes to its first field.
 * Its words are the toolkit's (`toolkit.save`, `toolkit.cancel`,
 * `toolkit.fillIn`).
 *
 * ```tsx
 * <EntityDialog
 *   title={customer ? customer.name : "New customer"}
 *   values={customer ?? defaults}
 *   fields={[
 *     { name: "name", label: "Name", required: true },
 *     { name: "email", label: "Email", type: "email" },
 *     { name: "since", label: "Customer since", type: "date", format: "dd/MM/yyyy", max: today },
 *   ]}
 *   errors={{ email: "That email address isn't complete." }}
 *   onSubmit={(record, _form, unset) => customer
 *     ? customers.updateOne({ _id: customer._id }, { $set: record, $unset: unset })
 *     : customers.insertOne(record)}
 *   toast="Customer saved."
 *   onClose={() => go("/customers")}
 * />
 * ```
 */
import { type ReactNode, useId, useState } from "react";
import { Button } from "./button.tsx";
import { Checkbox } from "./checkbox.tsx";
import { DatePicker } from "./date-picker.tsx";
import { DateTimePicker } from "./date-time-picker.tsx";
import { Dialog } from "./dialog.tsx";
import { type Control, Field } from "./field.tsx";
import { Form } from "./form.tsx";
import { entityValues, formValues } from "./form-values.ts";
import { Input } from "./input.tsx";
import { Picker, type PickerOption } from "./picker.tsx";
import { Textarea } from "./textarea.tsx";
import { toast } from "./toast-state.ts";
import { say } from "./words.ts";

/** A field of a record's form, as data: `EntityDialog` draws it as a `Field` and its control. */
export type EntityField = {
  /** The record's field: its key in the values, and what a save's refusal names (`detail.field`). */
  name: string;
  label: ReactNode;
  /**
   * Its control: `text` (the default), `email`, `tel`, `url` or `password`, an `Input`; `number`,
   * a number field whose value is a number; `textarea`; `select`, a `Picker` of `options`;
   * `checkbox`, `true` or `false`; `date`, a `DatePicker` (`YYYY-MM-DD`); `datetime`, a
   * `DateTimePicker` (`YYYY-MM-DD HH:mm`, or `HH:mm:ss` with `seconds`).
   */
  type?:
    | "text"
    | "email"
    | "tel"
    | "url"
    | "password"
    | "number"
    | "textarea"
    | "select"
    | "checkbox"
    | "date"
    | "datetime";
  /** A value is needed: the label is marked, and an empty one is said before the save. */
  required?: boolean;
  hint?: ReactNode;
  placeholder?: string;
  disabled?: boolean;
  /** A `select`'s choices. */
  options?: PickerOption[];
  /** A `select` with a box over its list that narrows it as it's typed. */
  search?: boolean;
  /** A `date`'s or a `datetime`'s pattern, the app's (`dd/MM/yyyy`, `dd/MM/yyyy HH:mm:ss`). */
  format?: string;
  /** A `datetime` to the second. */
  seconds?: boolean;
  /** The app's today, `YYYY-MM-DD`, for a `date` or a `datetime`. */
  today?: string;
  /** The app's time zone (IANA), where a `datetime` with no value opens. */
  timeZone?: string;
  /** The least it takes: a `number`'s, or a `date`'s or `datetime`'s day (or day-time). */
  min?: number | string;
  /** The most it takes, as `min`. */
  max?: number | string;
  /** A `number`'s step: any by default. */
  step?: number;
  /**
   * Any other control, drawn by the app: given the field's value, a way to set it, and what a
   * `Field` gives its control (its id, its `name`, how it reads).
   */
  render?(field: { value: unknown; set(value: unknown): void; control: Control }): ReactNode;
};

/** What a function child of an `EntityDialog` gets: the record as its form has it. */
export type EntityForm<T> = {
  /** The record as the form has it: its `values`, with the changes made. */
  values: Partial<T>;
  /** Changes some of its fields. */
  set(change: Partial<T>): void;
  /** Its save is under way. */
  saving: boolean;
};

/** An `EntityDialog`'s props. */
export type EntityDialogProps<T extends Record<string, unknown>> = {
  /** Whether it's open: `true` by default, for a dialog View shown at an address. */
  open?: boolean;
  title: ReactNode;
  /** Words under the title. */
  description?: ReactNode;
  /**
   * The initial record or defaults. The draft lasts for this `_id`, or this object's identity
   * when it has no `_id`. Supply the type with `<EntityDialog<Customer> …>`.
   * It defaults to `Record<string, unknown>`.
   */
  values?: NoInfer<Partial<T>>;
  /** Its fields, as data, drawn first. */
  fields?: EntityField[];
  /** More of the form: `Field`s, a View shown in it, or a function of the record as it is. */
  children?: ReactNode | ((form: EntityForm<T>) => ReactNode);
  /**
   * Saves it: given the record as the form leaves it (less its `_id`). Its failure shows by its
   * field (`detail.field`) or at the form's top. The third argument names previously populated
   * fields cleared to undefined (including an empty number), ready for `$unset` on an update.
   * The signal aborts when the dialog closes or switches records. Returning `false` keeps it open.
   */
  onSubmit(
    values: Omit<T, "_id">,
    form: HTMLFormElement,
    unset: Record<string, true>,
    signal: AbortSignal,
  ): unknown;
  /** It closes: Cancel, Escape, the backdrop, or a save done. */
  onClose(): void;
  /** What a toast says once it's saved (`"Customer saved."`). */
  toast?: ReactNode;
  /** People's words for a field a save refuses, by its name (a schema's are for developers). */
  errors?: Record<string, string>;
  /** The save button's words: "Save" by default. */
  submitLabel?: ReactNode;
  /** The cancel button's words: "Cancel" by default. */
  cancelLabel?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Near the top (the default: a form that grows stays put), or centred. */
  placement?: "center" | "top";
  /** Its fields' labels over their controls (the default), or beside them (`row`). */
  layout?: "stacked" | "row";
  /** The form's id. */
  id?: string;
};

export function EntityDialog<T extends Record<string, unknown> = Record<string, unknown>>(
  props: EntityDialogProps<T>,
): ReactNode {
  // A new editing session owns its draft, its submission and its field errors.
  const record = props.values?._id ?? props.values;
  const [session, setSession] = useState({ record, key: 0 });
  if (!Object.is(session.record, record)) setSession({ record, key: session.key + 1 });
  return props.open === false ? null : <RecordDialog key={session.key} {...props} />;
}

function RecordDialog<T extends Record<string, unknown>>(
  {
    title,
    description,
    values: given,
    fields = [],
    children,
    onSubmit,
    onClose,
    toast: done,
    errors,
    submitLabel,
    cancelLabel,
    size,
    placement = "top",
    layout = "stacked",
    id,
  }: EntityDialogProps<T>,
): ReactNode {
  const own = useId();
  const form = id ?? `${own}-form`;
  const start = (): Partial<T> => ({ ...given } as Partial<T>);
  const [draft, setDraft] = useState<Partial<T>>(start);
  const [missing, setMissing] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const set = (change: Partial<T>) => {
    setDraft((now) => ({ ...now, ...change }));
    setMissing((now) => now.filter((name) => !(name in change)));
  };
  const submit = async (
    handed: Record<string, unknown>,
    element: HTMLFormElement,
    signal: AbortSignal,
  ) => {
    const ready = entityValues(
      fields,
      { ...draft, ...formValues(element), ...handed },
      given,
    );
    setMissing(ready.missing);
    if (ready.missing.length) return;
    const answer = await onSubmit(ready.values as Omit<T, "_id">, element, ready.unset, signal);
    if (signal.aborted || answer === false) return;
    if (done) toast(done, "success");
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      size={size}
      placement={placement}
      busy={saving}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>{cancelLabel ?? say("cancel")}</Button>
          <Button type="submit" form={form} variant="primary" loading={saving}>
            {submitLabel ?? say("save")}
          </Button>
        </>
      }
    >
      <Form id={form} onSubmittingChange={setSaving} errors={errors} onSubmit={submit}>
        {fields.map((field) => (
          <Field
            key={field.name}
            name={field.name}
            label={field.label}
            hint={field.hint}
            required={field.required}
            layout={layout}
            error={missing.includes(field.name) ? say("fillIn") : undefined}
          >
            {(control) =>
              controlOf(
                field,
                draft[field.name],
                (value) => set({ [field.name]: value } as Partial<T>),
                control,
              )}
          </Field>
        ))}
        {typeof children === "function" ? children({ values: draft, set, saving }) : children}
      </Form>
    </Dialog>
  );
}

/** A field's control, by its kind, holding its value. */
function controlOf(
  field: EntityField,
  value: unknown,
  set: (value: unknown) => void,
  control: Control,
): ReactNode {
  if (field.render) return field.render({ value, set, control });
  const text = value === undefined || value === null ? "" : String(value);
  const named = typeof field.label === "string" ? field.label : field.name;
  const bound = (b: number | string | undefined) => (b === undefined ? undefined : String(b));
  switch (field.type ?? "text") {
    case "textarea":
      return (
        <Textarea
          {...control}
          value={text}
          required={field.required}
          placeholder={field.placeholder}
          disabled={field.disabled}
          onChange={(event) => set(event.target.value)}
        />
      );
    case "checkbox":
      return (
        <Checkbox
          {...control}
          checked={value === true}
          disabled={field.disabled}
          onChange={(event) => set(event.target.checked)}
        />
      );
    case "select":
      return (
        <Picker
          id={control.id}
          label={named}
          options={field.options ?? []}
          value={text || undefined}
          search={field.search}
          placeholder={field.placeholder}
          disabled={field.disabled}
          onChange={set}
        />
      );
    case "date":
      return (
        <DatePicker
          id={control.id}
          label={named}
          value={text || undefined}
          onChange={set}
          format={field.format}
          today={field.today}
          min={bound(field.min)}
          max={bound(field.max)}
          placeholder={field.placeholder}
          disabled={field.disabled}
        />
      );
    case "datetime":
      return (
        <DateTimePicker
          id={control.id}
          label={named}
          value={text || undefined}
          onChange={set}
          format={field.format}
          seconds={field.seconds}
          today={field.today}
          timeZone={field.timeZone}
          min={bound(field.min)}
          max={bound(field.max)}
          placeholder={field.placeholder}
          disabled={field.disabled}
        />
      );
    case "number":
      return (
        <Input
          {...control}
          type="number"
          step={field.step ?? "any"}
          min={field.min}
          max={field.max}
          value={text}
          required={field.required}
          placeholder={field.placeholder}
          disabled={field.disabled}
          onChange={(event) => set(event.target.value)}
        />
      );
    default:
      return (
        <Input
          {...control}
          type={field.type ?? "text"}
          value={text}
          required={field.required}
          placeholder={field.placeholder}
          disabled={field.disabled}
          onChange={(event) => set(event.target.value)}
        />
      );
  }
}
