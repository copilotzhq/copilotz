/**
 * A record in a dialog, to add or edit: a `Dialog` holding a `Form`, with Cancel and Save in its
 * footer. Its fields are the app's own `Field`s, given as a function of `form`, whose binders
 * tie each control to a field of the record (`form.text("name")`, `form.number("price")`…).
 *
 * The dialog keeps a draft of what was edited, over the record as the View reads it now:
 * a field nobody touched always shows its newest value. Save gives `onSave` a change:
 *
 * - **a new record** (no `record`): `{ kind: "create", values }`, its `defaults` with the edits.
 *   For `insertOne(change.values)`.
 * - **a stored record**: `{ kind: "update", _id, set, unset, update }`, only what changed. An
 *   untouched field is never in it. A field given a value is in `set`. A text, number or choice
 *   emptied is a clear, in `unset`. A list emptied is `[]`, in `set`. A checkbox is `true` or
 *   `false`. `update` is the same as a MongoDB update (`$set`, `$unset`), for
 *   `updateOne({ _id: change._id }, change.update)`. A handler that keeps `null` for a cleared
 *   field sets `null` for each name in `unset`. An Action takes `set` and `unset` as its input.
 *   With nothing changed, `onSave` isn't called and the dialog just closes.
 *
 * A `useFormSubmit` part (another plugin's View shown in the fields) takes part in the save: what
 * it hands up is set too. Values are read when the save starts, after the parts, so what's typed
 * while a part uploads is saved. While it saves, Save is busy and the dialog can't be dismissed.
 * A save that's refused by its field (`detail.field`: a schema's refusal, an Action's `failure`
 * with a `detail`) shows under the `Field` whose `error` is `form.error(name)`, in the words
 * `errors` gives for it (a schema's are for developers), or its own; the focus goes to its
 * control. Any other failure shows at the form's top. Done, a `toast` says so and the dialog
 * closes (`onClose`).
 *
 * Each record is a session of its own (its `_id`, or a new one), and so is each time it opens: a
 * draft or a refusal never shows on another record. A save runs to its end in the session it
 * started in, with that session's record and handlers. If the dialog moved to another record,
 * closed, or went meanwhile, it calls no `onClose` and shows nothing: its outcome is a toast.
 *
 * In a dialog View, `ctx.show` goes in the View's body, not in the function.
 *
 * ```tsx
 * <RecordDialog<Customer>
 *   title={customer ? customer.name : "New customer"}
 *   record={customer}
 *   defaults={{ since: today }}
 *   errors={{ email: "That email address isn't complete." }}
 *   toast="Customer saved."
 *   onSave={(change) =>
 *     change.kind === "create"
 *       ? customers.insertOne(change.values)
 *       : customers.updateOne({ _id: change._id }, change.update)}
 *   onClose={close}
 * >
 *   {(form) => (
 *     <>
 *       <Field layout="row" label="Name" required error={form.error("name")}>
 *         {(control) => <Input {...control} {...form.text("name")} required />}
 *       </Field>
 *       <Field layout="row" label="Email" error={form.error("email")}>
 *         {(control) => <Input {...control} {...form.text("email")} type="email" />}
 *       </Field>
 *       <Field layout="row" label="Since" htmlFor="since" error={form.error("since")}>
 *         <DatePicker id="since" {...form.value("since")} today={today} format={dayFormat} />
 *       </Field>
 *     </>
 *   )}
 * </RecordDialog>
 * ```
 */
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "./button.tsx";
import { Dialog } from "./dialog.tsx";
import { Form, useFormState } from "./form.tsx";
import { Notice } from "./notice.tsx";
import {
  createOf,
  type DraftKind,
  type Edits,
  holds,
  type RecordUpdate,
  refusalWords,
  related,
  savedOf,
  shownAs,
  updateOf,
  valueAt,
  withValue,
} from "./record-draft.ts";
import { refusedField } from "./refusal.ts";
import { useReturnFocus } from "./return-focus.ts";
import { toast } from "./toast-state.ts";
import { say } from "./words.ts";

export type { RecordUpdate } from "./record-draft.ts";

/** What a text control's `onChange` hears: its event, or its text. */
type TextChange = string | { target: { value: string } };
/** What a checkbox's or a switch's `onChange` hears: its event, or whether it's on. */
type CheckedChange = boolean | { target: { checked: boolean } };

/**
 * What a `RecordDialog`'s fields bind to: its draft, by field name or dot path (`address.city`).
 * Spread a binder on its control: `<Input {...control} {...form.text("name")} />`. Bind each
 * field once; `_id` isn't a field.
 */
export type RecordForm<T> = {
  /** The record as the form shows it: the stored record (or the defaults), with the edits made. */
  record: Partial<T>;
  /** A save is under way. */
  saving: boolean;
  /** For an `Input`, a `Textarea` or a `Select`: the text. Emptied, the field is cleared. */
  text(name: string): { name: string; value: string; onChange(change: TextChange): void };
  /**
   * For a number `Input` (`type="number"`, any step): its text while it's typed, a number once
   * saved (text that isn't one stays text, for the schema to refuse). Emptied, it's cleared.
   */
  number(name: string): {
    name: string;
    type: "number";
    step: "any";
    value: string;
    onChange(change: TextChange): void;
  };
  /** For a `Checkbox` or a `Switch`: `true` or `false`, never cleared. */
  checked(name: string): { name: string; checked: boolean; onChange(change: CheckedChange): void };
  /** For one `Radio` of a choice: checked while the field is `option`, which choosing it sets. */
  radio(name: string, option: string): {
    name: string;
    value: string;
    checked: boolean;
    onChange(change: CheckedChange): void;
  };
  /**
   * For a control that gives its value (`Picker`, `DatePicker`, `DateTimePicker`): `undefined`,
   * `null` or `""` clears the field.
   */
  value<V = string>(name: string): {
    value: NoInfer<V> | undefined;
    onChange(value: NoInfer<V> | undefined): void;
  };
  /** For a control of several values (`TagsInput`, `MultiPicker`): emptied, it's the empty list. */
  list<V = string>(name: string): { values: NoInfer<V>[]; onChange(values: NoInfer<V>[]): void };
  /** A field as the form has it, for a control of the app's own. */
  get(name: string): unknown;
  /** Sets a field from a control of the app's own: `undefined` clears it, and `null` is a value. */
  set(name: string, value: unknown): void;
  /**
   * What the last save's refusal says of this field, or of a field inside it (`lines` holds
   * `lines.0.qty`): give it to the field's `Field` as its `error`. Asking marks the field as
   * shown: a refusal no field asks for shows at the form's top. Ask in this function itself.
   */
  error(name: string): ReactNode | undefined;
};

/** A `RecordDialog`'s save: a new record's values, or what changed in a stored one. */
export type RecordChange<T> =
  | {
    kind: "create";
    /**
     * The defaults with the edits: a cleared field left out, what parts handed up merged in. The
     * browser doesn't check that it's a whole `T`; the collection's schema does, on insert.
     */
    values: T;
  }
  | {
    kind: "update";
    /** The record's `_id`, for the save's filter. */
    _id: string;
    /** Fields given a value, by name or dot path, and what parts handed up (never `_id`). */
    set: Record<string, unknown>;
    /** Fields cleared: a text, number or choice emptied that had a value. */
    unset: string[];
    /** The same as a MongoDB update, for `updateOne({ _id: change._id }, change.update)`. */
    update: RecordUpdate;
    /** The stored record the change was made against, as the dialog last drew it. */
    record: T & { _id: string };
  };

/** A `RecordDialog`'s props. */
export type RecordDialogProps<T extends Record<string, unknown>> = {
  /** Whether it's open: `true` by default, for a dialog View shown at an address. */
  open?: boolean;
  title: ReactNode;
  /** Words under the title. */
  description?: ReactNode;
  /**
   * The stored record to edit, as the View reads it, live: a field not edited shows its newest
   * value. Without it, the dialog makes a new one. Another `_id` is another record, with a draft
   * of its own.
   */
  record?: T & { _id: string };
  /** A new record's starting values (not used with `record`). */
  defaults?: Partial<T>;
  /**
   * The form's fields, given `form`: `Field`s whose controls take its binders. They're drawn in
   * a `Form`, so a `useFormSubmit` part takes part in the save.
   */
  children(form: RecordForm<T>): ReactNode;
  /**
   * Saves it: a plain save (`insertOne(change.values)`, `updateOne({ _id: change._id },
   * change.update)`) or an Action (`ctx.call`). Not called when nothing changed. While it runs,
   * the dialog is busy; a refusal shows under the field it names, or at the form's top.
   */
  onSave(change: RecordChange<T>, form: HTMLFormElement): unknown;
  /**
   * It's done: Cancel, Escape, the backdrop, ×, or a save that ended. Called once. Closing it
   * yourself (`open={false}`, or not drawing it) calls nothing.
   */
  onClose(): void;
  /** What a toast says once it's saved: "Customer saved." */
  toast?: ReactNode;
  /** People's words for a refused field, by its name or dot path (a schema's are for developers). */
  errors?: Record<string, ReactNode>;
  /** The save button's words: "Save". */
  saveLabel?: ReactNode;
  /** The cancel button's words: "Cancel". */
  cancelLabel?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Near the top (the default: a form that grows stays put), or centred. */
  placement?: "center" | "top";
  /** The form's id: Save, in the footer, submits it by its id. */
  id?: string;
};

/**
 * A record in a dialog, to add or to edit: its fields bound to a draft, Save sending only what
 * changed (see the top of this file).
 */
export function RecordDialog<T extends Record<string, unknown> = Record<string, unknown>>(
  props: RecordDialogProps<T>,
): ReactNode {
  const open = props.open !== false;
  useReturnFocus(open);
  if (!open) return null;
  // A session per record, and per time it opens: its draft, its refusal and its busy state.
  const subject = props.record ? `record:${String(props.record._id)}` : "new";
  return <Session<T> key={subject} {...props} />;
}

/** A save's refusal: the field it's about, if any, and its words. */
type Refused = { field?: string; words: ReactNode };

/** One record, for as long as it's open. */
function Session<T extends Record<string, unknown>>(props: RecordDialogProps<T>): ReactNode {
  const { title, description, record, defaults, children, size, placement = "top" } = props;
  const own = useId();
  const formId = props.id ?? `${own}-form`;
  const [edits, setEdits] = useState<Edits>({});
  /** The edits as they are now, every one so far: what a save reads. */
  const draft = useRef<Edits>(edits);
  const [refused, setRefused] = useState<Refused>();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const latest = useRef(props);
  latest.current = props;
  /** Shown, and not dismissed: what a save's end may still act on. */
  const here = useRef(false);
  useLayoutEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);

  const base = (record ?? defaults ?? {}) as Record<string, unknown>;
  const edit = (path: string, kind: DraftKind, raw: unknown) => {
    draft.current = { ...draft.current, [path]: { kind, raw } };
    setEdits(draft.current);
    // Editing a refused field takes its refusal away.
    setRefused((now) => (now?.field !== undefined && related(now.field, path) ? undefined : now));
  };
  const current = (path: string) =>
    Object.hasOwn(edits, path) ? savedOf(edits[path]) : valueAt(base, path);
  const shown = (path: string, kind: DraftKind) =>
    Object.hasOwn(edits, path) && edits[path].kind === kind
      ? edits[path].raw
      : shownAs(kind, current(path));
  const asked: string[] = [];
  const form: RecordForm<T> = {
    record: Object.entries(edits).reduce(
      (at, [path, change]) => withValue(at, path, savedOf(change)),
      base,
    ) as Partial<T>,
    saving: busy,
    text: (name) => ({
      name,
      value: shown(name, "text") as string,
      onChange: (change) =>
        edit(name, "text", typeof change === "string" ? change : change.target.value),
    }),
    number: (name) => ({
      name,
      type: "number",
      step: "any",
      value: shown(name, "number") as string,
      onChange: (change) =>
        edit(name, "number", typeof change === "string" ? change : change.target.value),
    }),
    checked: (name) => ({
      name,
      checked: shown(name, "checked") as boolean,
      onChange: (change) =>
        edit(name, "checked", typeof change === "boolean" ? change : change.target.checked),
    }),
    radio: (name, option) => ({
      name,
      value: option,
      checked: current(name) === option,
      onChange: (change) => {
        if (typeof change === "boolean" ? change : change.target.checked) {
          edit(name, "radio", option);
        }
      },
    }),
    value: <V,>(name: string) => ({
      value: shown(name, "value") as V | undefined,
      onChange: (value: V | undefined) => edit(name, "value", value),
    }),
    list: <V,>(name: string) => ({
      values: shown(name, "list") as V[],
      onChange: (values: V[]) => edit(name, "list", values),
    }),
    get: current,
    set: (name, value) => edit(name, "set", value),
    error: (name) => {
      asked.push(name);
      return refused?.field !== undefined && holds(name, refused.field) ? refused.words : undefined;
    },
  };
  const fields = children(form);
  // A refusal no field asked for shows at the form's top.
  const top =
    refused && !(refused.field !== undefined && asked.some((n) => holds(n, refused.field!)))
      ? refused.words
      : undefined;
  const atTop = top !== undefined;

  // After a refusal, the focus goes to its field's control, or back to Save if it was lost
  // (Save waits disabled while the form saves, so that's once it's done).
  useEffect(() => {
    if (!refused || busy) return;
    const element = document.getElementById(formId) as HTMLFormElement | null;
    if (!atTop && refused.field && element) {
      const keys = refused.field.split(".");
      for (let n = keys.length; n > 0; n--) {
        const named = element.elements.namedItem(keys.slice(0, n).join(".")) as
          | (HTMLElement & { length?: number; [index: number]: HTMLElement })
          | null;
        const control = named && typeof named.focus === "function" ? named : named?.[0];
        if (control) return control.focus();
      }
    }
    const now = document.activeElement;
    if (!now || now === document.body) document.getElementById(`${own}-save`)?.focus();
  }, [refused, busy]);

  const save = async (handed: Record<string, unknown>, element: HTMLFormElement) => {
    const now = latest.current;
    let change: RecordChange<T>;
    if (now.record) {
      const changed = updateOf(now.record, draft.current, handed);
      if (!changed) {
        if (here.current) now.onClose();
        return;
      }
      change = { kind: "update", _id: String(now.record._id), ...changed, record: now.record };
    } else {
      const values = createOf(
        (now.defaults ?? {}) as Record<string, unknown>,
        draft.current,
        handed,
      );
      change = { kind: "create", values: values as T };
    }
    try {
      await now.onSave(change, element);
    } catch (error) {
      const field = refusedField(error);
      const words = refusalWords(field, error, latest.current.errors) ?? say("notSaved");
      if (here.current) setRefused({ field, words });
      else toast(words, "destructive");
      return;
    }
    const after = latest.current;
    if (after.toast) toast(after.toast, "success");
    if (here.current) after.onClose();
  };
  const dismissed = () => {
    // Closed by the browser while it saves: the save goes on, out of view.
    if (saving.current) here.current = false;
    latest.current.onClose();
  };

  return (
    <Dialog
      open
      onClose={dismissed}
      title={title}
      description={description}
      size={size}
      placement={placement}
      busy={busy}
      footer={
        <>
          <Button onClick={() => latest.current.onClose()} disabled={busy}>
            {props.cancelLabel ?? say("cancel")}
          </Button>
          <Button id={`${own}-save`} type="submit" form={formId} variant="primary" loading={busy}>
            {props.saveLabel ?? say("save")}
          </Button>
        </>
      }
    >
      {/* A new attempt takes the last refusal away, before the form's own handler runs. */}
      <div onSubmitCapture={() => setRefused(undefined)}>
        <Form id={formId} onSubmit={save}>
          <Busy
            on={(yes) => {
              saving.current = yes;
              setBusy(yes);
            }}
          />
          {atTop ? <Notice tone="destructive" role="alert">{top}</Notice> : null}
          {fields}
        </Form>
      </div>
    </Dialog>
  );
}

/** Says when the `Form` around it saves: from its submit until its save, or a part, ends. */
function Busy({ on }: { on(busy: boolean): void }): null {
  const { submitting } = useFormState();
  const latest = useRef(on);
  latest.current = on;
  useLayoutEffect(() => latest.current(submitting), [submitting]);
  return null;
}
