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
 * it hands up is set too, compared with the record as an edit is, and over an edit of the same
 * field, unless that edit was made after the submit started (a correction typed while the part
 * works wins). The fields take edits while the parts run: what's typed while a part uploads is
 * saved. The values are read, and checked by the browser again (`required`), when the save
 * starts; from then until it answers the draft takes no edits and text and number fields are
 * `readOnly`. Nothing is disabled or inert, so `new FormData(form)` in `onSave` holds every field
 * and a question asked during the save can be answered. After a refusal the fields take edits
 * again, the draft as it was. While it saves, Save is busy and the dialog can't be dismissed.
 * A save that's refused by its field (`detail.field`: a schema's refusal, an Action's `failure`
 * with a `detail`) shows under the `Field` whose `error` is `form.error(name)`, in the words
 * `errors` gives for it (a schema's are for developers), or its own; the focus goes to its
 * control. Any other failure shows at the form's top. Done, a `toast` says so and the dialog
 * closes (`onClose`).
 *
 * Each record is a session of its own (its `_id`, or a new one), and so is each time it opens: a
 * draft or a refusal never shows on another record. A save runs to its end in the session it
 * started in, with that session's record and handlers. If the dialog moved to another record,
 * closed, or went meanwhile, it calls no `onClose` and shows nothing: its outcome is a toast. A
 * session ends once (Cancel, Escape, the backdrop, ×, a save done or nothing to save) and tells
 * `onClose` once; until it closes, it takes no more edits or saves. Its actions use the props it
 * was last drawn with on the screen, never those of a render React didn't commit. It answers only
 * its own close and submit, not a dialog's shown inside it.
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
import { sheet } from "./sheet.tsx";
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
  /**
   * For an `Input`, a `Textarea` or a `Select`: the text. Emptied, the field is cleared.
   * `readOnly` while a save has the values, and once the session is done.
   */
  text(name: string): {
    name: string;
    value: string;
    readOnly: boolean;
    onChange(change: TextChange): void;
  };
  /**
   * For a number `Input` (`type="number"`, any step): its text while it's typed, a number once
   * saved (text that isn't one stays text, for the schema to refuse). Emptied, it's cleared.
   * `readOnly` while a save has the values, and once the session is done.
   */
  number(name: string): {
    name: string;
    type: "number";
    step: "any";
    value: string;
    readOnly: boolean;
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
    onChange(value: NoInfer<V> | null | undefined): void;
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

/**
 * Where a record's session is: `open` (its fields take edits, Save takes a save), `saving`
 * (its save has its values: the fields are read-only until it answers), or `done` (it closed,
 * or its save is done: it takes nothing more until a new session).
 */
type Phase = "open" | "saving" | "done";

const SHEET = sheet("record-dialog", `.copilotz-record-fields { display: contents; }`);

/**
 * One record, for as long as it's open. Its actions use what it was drawn with when last
 * committed, never a render React didn't show; it ends once, and tells `onClose` once.
 */
function Session<T extends Record<string, unknown>>(props: RecordDialogProps<T>): ReactNode {
  const { title, description, record, defaults, children, size, placement = "top" } = props;
  const own = useId();
  const formId = props.id ?? `${own}-form`;
  const [edits, setEdits] = useState<Edits>({});
  /** The edits as they are now, every one so far: what a save reads. */
  const draft = useRef<Edits>(edits);
  const [refused, setRefused] = useState<Refused>();
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  /** The props as last committed: what the person sees. */
  const committed = useRef(props);
  useLayoutEffect(() => {
    committed.current = props;
  });
  const phase = useRef<Phase>("open");
  /** `onClose` was called: this session told its owner it's done. */
  const told = useRef(false);
  /** The form runs a submit: its parts, then its save. */
  const running = useRef(false);
  /** The edits as they were when the running submit started. */
  const atStart = useRef<Edits>({});
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const box = useRef<HTMLDivElement>(null);
  const ownForm = () => (box.current?.firstElementChild as HTMLFormElement | null) ?? null;

  /** Ends the session and tells the owner, once. */
  const tell = () => {
    if (told.current) return;
    told.current = true;
    phase.current = "done";
    setLocked(true);
    committed.current.onClose();
  };
  /** Still the one on the screen: mounted, not done, and its `<dialog>` still open. */
  const shown = () =>
    mounted.current && !told.current && ownForm()?.closest("dialog")?.open === true;

  const base = (record ?? defaults ?? {}) as Record<string, unknown>;
  const edit = (path: string, kind: DraftKind, raw: unknown) => {
    // Read-only while a save has its values, and once the session is done.
    if (phase.current !== "open") return;
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
      readOnly: locked,
      onChange: (change) =>
        edit(name, "text", typeof change === "string" ? change : change.target.value),
    }),
    number: (name) => ({
      name,
      type: "number",
      step: "any",
      value: display(name, "number") as string,
      readOnly: locked,
      onChange: (change) =>
        edit(name, "number", typeof change === "string" ? change : change.target.value),
    }),
    checked: (name) => ({
      name,
      checked: display(name, "checked") as boolean,
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

  // What `Form` calls once its parts are done. `Form` keeps the onSubmit it was last drawn with,
  // committed or not, so this reads nothing of a render: only what's committed, and the draft.
  const save = useCallback(async (handed: Record<string, unknown>, element: HTMLFormElement) => {
    const now = committed.current;
    const here = shown() && phase.current === "open";
    // What changed while a part ran is checked again, as the save starts.
    if (here && !element.checkValidity()) {
      element.reportValidity();
      return;
    }
    // What the person edited after the submit started wins over a part's value for that field.
    const later = new Set(
      Object.keys(draft.current).filter((path) => draft.current[path] !== atStart.current[path]),
    );
    let change: RecordChange<T>;
    if (now.record) {
      const changed = updateOf(now.record, draft.current, handed, later);
      if (!changed) {
        if (here) tell();
        return;
      }
      change = { kind: "update", _id: String(now.record._id), ...changed, record: now.record };
    } else {
      const values = createOf(
        (now.defaults ?? {}) as Record<string, unknown>,
        draft.current,
        handed,
        later,
      );
      change = { kind: "create", values: values as T };
    }
    // The save has its values: the fields are read-only until it answers.
    if (here) {
      phase.current = "saving";
      setLocked(true);
    }
    let failure: { error: unknown } | undefined;
    try {
      await now.onSave(change, element);
    } catch (error) {
      failure = { error };
    }
    const after = committed.current;
    // Closed by the browser meanwhile, its close event maybe still on its way: dismissed now.
    if (mounted.current && !told.current && element.closest("dialog")?.open !== true) tell();
    const still = mounted.current && !told.current;
    if (failure) {
      const field = refusedField(failure.error);
      const words = refusalWords(field, failure.error, after.errors) ?? say("notSaved");
      if (still) {
        phase.current = "open";
        setLocked(false);
        setRefused({ field, words });
      } else toast(words, "destructive");
      return;
    }
    if (after.toast) toast(after.toast, "success");
    if (still) tell();
  }, []);
  const onBusy = useCallback((yes: boolean) => {
    running.current = yes;
    setBusy(yes);
  }, []);
  const cancel = () => {
    if (phase.current === "open" && !running.current) tell();
  };

  return (
    <Dialog
      open
      // Its own close only (Escape, the backdrop, ×, the browser): told once. While it saves,
      // that's a dismissal: the save goes on, out of view.
      onClose={tell}
      isolated
      title={title}
      description={description}
      size={size}
      placement={placement}
      busy={busy}
      footer={
        <>
          <Button onClick={cancel} disabled={busy || locked}>
            {props.cancelLabel ?? say("cancel")}
          </Button>
          <Button
            id={`${own}-save`}
            type="submit"
            form={formId}
            variant="primary"
            loading={busy}
            disabled={locked}
          >
            {props.saveLabel ?? say("save")}
          </Button>
        </>
      }
    >
      {SHEET}
      <div
        ref={box}
        onSubmitCapture={(event) => {
          // A form inside the fields (another record's dialog) submits on its own.
          if (event.target !== ownForm()) return;
          // Done, or its save running: a new submit doesn't start.
          if (phase.current !== "open") {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          // A new attempt takes the last refusal away, before the form's own handler runs, and
          // keeps the draft as it is: an edit made after this is a correction.
          if (!running.current) atStart.current = draft.current;
          setRefused(undefined);
        }}
        // Its submit never reaches a form around this dialog.
        onSubmit={(event) => event.stopPropagation()}
      >
        <Form id={formId} onSubmit={save}>
          <Busy on={onBusy} />
          {atTop ? <Notice tone="destructive" role="alert">{top}</Notice> : null}
          {/* A form in the fields (an app's own, in a dialog or not) submits on its own. */}
          <div
            className="copilotz-record-fields"
            onSubmit={(event) => {
              if (event.target !== ownForm()) event.stopPropagation();
            }}
          >
            {fields}
          </div>
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
