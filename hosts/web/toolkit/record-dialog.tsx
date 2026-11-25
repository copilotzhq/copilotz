/**
 * A record in a dialog, to add or edit: a `Dialog` holding a `Form`, Cancel and Save in its
 * footer, and the app's own `Field`s given as a function of `form`, whose binders tie each control
 * to a field (`form.text("name")`). It keeps a draft of the edits over the record as the View
 * reads it now, and Save gives `onSave` only what changed (`RecordChange`); with nothing changed,
 * it just closes. While it saves, Save is busy and the dialog stays. A refusal of a field
 * (`detail.field`) shows under the `Field` whose `error` is `form.error(name)`, in `errors`'
 * words; any other, at the form's top. Done, it says `toast` and closes. Each record, and each
 * time it opens, is a session of its own: its save goes through its own record and handlers, it
 * calls `onClose` once, and a save whose dialog went meanwhile ends with a toast.
 *
 * ```tsx
 * <RecordDialog<Customer> title="Customer" record={customer} toast="Customer saved."
 *   onSave={(change) => change.kind === "create"
 *     ? customers.insertOne(change.values)
 *     : customers.updateOne({ _id: change._id }, change.update)}
 *   onClose={close}>
 *   {(form) => <Field label="Name" error={form.error("name")}>
 *     {(control) => <Input {...control} {...form.text("name")} required />}</Field>}
 * </RecordDialog>
 * ```
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
type TextBinding = { name: string; value: string; onChange(change: TextChange): void };
type CheckedBinding = { name: string; checked: boolean; onChange(change: CheckedChange): void };

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
  text(name: string): TextBinding;
  /** For a number `Input`: its text while typed, a number once saved. Emptied, it's cleared. */
  number(name: string): TextBinding & { type: "number"; step: "any" };
  /** For a `Checkbox` or a `Switch`: `true` or `false`, never cleared. */
  checked(name: string): CheckedBinding;
  /** For one `Radio` of a choice: checked while the field is `option`, which choosing it sets. */
  radio(name: string, option: string): CheckedBinding & { value: string };
  /** For a `Picker`, `DatePicker` or `DateTimePicker`: `undefined`, `null` or `""` clears it. */
  value<V = string>(name: string): {
    value: NoInfer<V> | undefined;
    onChange(value: NoInfer<V> | null | undefined): void;
  };
  /** For a control of several values (`TagsInput`, `MultiPicker`): emptied, it's the empty list. */
  list<V = string>(name: string): { values: NoInfer<V>[]; onChange(values: NoInfer<V>[]): void };
  /** A field as the form has it, for a control of the app's own. */
  get(name: string): unknown;
  /** Sets a field from a control of the app's own: `undefined` clears it, and `null` is a value. */
  set(name: string, value: unknown): void;
  /** The last refusal's words for this field or one inside it, for its `Field`'s `error`. */
  error(name: string): ReactNode | undefined;
};

/** A `RecordDialog`'s save: a new record's values, or what changed in a stored one. */
export type RecordChange<T> =
  | {
    kind: "create";
    /** The defaults with the edits and the parts' values; the schema checks it's a `T`. */
    values: T;
  }
  | {
    kind: "update";
    /** The record's `_id`, for the save's filter. */
    _id: string;
    /** Fields given a value (a list emptied is `[]`), and what parts handed up. */
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
  /** The stored record to edit, live; without it, a new one. Another `_id` is another draft. */
  record?: T & { _id: string };
  /** A new record's starting values (not used with `record`). */
  defaults?: Partial<T>;
  /** The form's fields, given `form`: `Field`s whose controls take its binders. */
  children(form: RecordForm<T>): ReactNode;
  /** Saves it: `insertOne`, `updateOne({ _id }, change.update)` or an Action. */
  onSave(change: RecordChange<T>, form: HTMLFormElement): unknown;
  /** It's done (Cancel, Escape, the backdrop, ×, a save): once. Closing it yourself, never. */
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

/** A record in a dialog, to add or to edit (see the top of this file). */
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

/** One record, for as long as it's open; its actions use the props last committed. */
function Session<T extends Record<string, unknown>>(props: RecordDialogProps<T>): ReactNode {
  const { title, description, record, defaults, children, size, placement = "top" } = props;
  const own = useId();
  const formId = props.id ?? `${own}-form`;
  const [edits, setEdits] = useState<Edits>({});
  /** The edits as they are now, every one so far: what a save reads. */
  const draft = useRef<Edits>(edits);
  const [refused, setRefused] = useState<Refused>();
  const [busy, setBusy] = useState(false);
  /** The props as last committed: what the person sees. */
  const committed = useRef(props);
  useLayoutEffect(() => {
    committed.current = props;
  });
  /** `onClose` was called: the session is done, and takes no more saves. */
  const done = useRef(false);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Ends the session and tells the owner, once. */
  const tell = () => {
    if (done.current) return;
    done.current = true;
    committed.current.onClose();
  };

  const base = (record ?? defaults ?? {}) as Record<string, unknown>;
  const edit = (path: string, kind: DraftKind, raw: unknown) => {
    draft.current = { ...draft.current, [path]: { kind, raw } };
    setEdits(draft.current);
    // Editing a refused field takes its refusal away.
    setRefused((now) => (now?.field !== undefined && related(now.field, path) ? undefined : now));
  };
  const current = (path: string) =>
    Object.hasOwn(edits, path) ? savedOf(edits[path]) : valueAt(base, path);
  const display = (path: string, kind: DraftKind) =>
    Object.hasOwn(edits, path) && edits[path].kind === kind
      ? edits[path].raw
      : shownAs(kind, current(path));
  const typed = (path: string, kind: DraftKind) => (change: TextChange) =>
    edit(path, kind, typeof change === "string" ? change : change.target.value);
  const on = (change: CheckedChange) =>
    typeof change === "boolean" ? change : change.target.checked;
  const asked: string[] = [];
  const form: RecordForm<T> = {
    record: Object.entries(edits).reduce(
      (at, [path, change]) => withValue(at, path, savedOf(change)),
      base,
    ) as Partial<T>,
    saving: busy,
    text: (name) => ({
      name,
      value: display(name, "text") as string,
      onChange: typed(name, "text"),
    }),
    number: (name) => ({
      name,
      type: "number",
      step: "any",
      value: display(name, "number") as string,
      onChange: typed(name, "number"),
    }),
    checked: (name) => ({
      name,
      checked: display(name, "checked") as boolean,
      onChange: (change) => edit(name, "checked", on(change)),
    }),
    radio: (name, option) => ({
      name,
      value: option,
      checked: current(name) === option,
      onChange: (change) => on(change) && edit(name, "radio", option),
    }),
    value: <V,>(name: string) => ({
      value: display(name, "value") as V | undefined,
      onChange: (value: V | null | undefined) => edit(name, "value", value),
    }),
    list: <V,>(name: string) => ({
      values: display(name, "list") as V[],
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

  // After a refusal, the focus goes to its field's control, or back to Save if it was lost.
  useEffect(() => {
    if (!refused || busy) return;
    const element = document.getElementById(formId) as HTMLFormElement | null;
    const named = refused.field ? element?.elements.namedItem(refused.field) : null;
    if (typeof (named as HTMLElement | null)?.focus === "function") {
      return (named as HTMLElement).focus();
    }
    const now = document.activeElement;
    if (!now || now === document.body) document.getElementById(`${own}-save`)?.focus();
  }, [refused, busy]);

  // What `Form` calls once its parts are done. `Form` keeps the onSubmit it was last drawn with,
  // committed or not, so this reads nothing of a render: only what's committed, and the draft.
  const save = useCallback(async (handed: Record<string, unknown>, element: HTMLFormElement) => {
    const now = committed.current;
    let change: RecordChange<T>;
    if (now.record) {
      const changed = updateOf(now.record, draft.current, handed);
      if (!changed) {
        if (mounted.current) tell();
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
    let failure: { error: unknown } | undefined;
    try {
      await now.onSave(change, element);
    } catch (error) {
      failure = { error };
    }
    const after = committed.current;
    // Still on the screen: this session's dialog, not closed or gone meanwhile.
    const here = mounted.current && !done.current;
    if (failure) {
      const field = refusedField(failure.error);
      const words = refusalWords(field, failure.error, after.errors) ?? say("notSaved");
      if (here) setRefused({ field, words });
      else toast(words, "destructive");
      return;
    }
    if (after.toast) toast(after.toast, "success");
    if (here) tell();
  }, []);
  const onBusy = useCallback((yes: boolean) => setBusy(yes), []);

  return (
    <Dialog
      open
      // Its own close only (Escape, the backdrop, ×, the browser): told once. While it saves,
      // the save goes on, out of view.
      onClose={tell}
      isolated
      title={title}
      description={description}
      size={size}
      placement={placement}
      busy={busy}
      footer={
        <>
          <Button onClick={tell} disabled={busy}>
            {props.cancelLabel ?? say("cancel")}
          </Button>
          <Button id={`${own}-save`} type="submit" form={formId} variant="primary" loading={busy}>
            {props.saveLabel ?? say("save")}
          </Button>
        </>
      }
    >
      <div
        onSubmitCapture={(event) => {
          // Done: a new submit doesn't start (no second save).
          if (done.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          // A new attempt takes the last refusal away, before the form's own handler runs.
          setRefused(undefined);
        }}
      >
        <Form id={formId} onSubmit={save}>
          <Busy on={onBusy} />
          {top !== undefined ? <Notice tone="destructive" role="alert">{top}</Notice> : null}
          {fields}
        </Form>
      </div>
    </Dialog>
  );
}

/** Says when the `Form` around it saves: from its submit until its save, or a part, ends. */
function Busy({ on }: { on(busy: boolean): void }): null {
  const { submitting } = useFormState();
  useLayoutEffect(() => on(submitting), [submitting, on]);
  return null;
}
