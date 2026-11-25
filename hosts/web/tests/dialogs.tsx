/**
 * The confirmation and the record dialog, mounted: what a save sends (only what changed, a clear
 * as an unset), which record and which handlers it goes through when the dialog moves on before
 * it ends, what a busy dialog refuses, where a refusal shows, when `onClose` is called, and where
 * the focus goes. `useConfirm`'s questions belong to the component that asks.
 */
import assert from "node:assert/strict";
import { act, type ReactNode, useEffect, useState } from "react";
import { createRuntime, definePlugin, type ViewContext } from "../../../runtime/mod.ts";
import type { Collection } from "../../../runtime/collection.ts";
import { memoryStore } from "../../../stores/memory/mod.ts";
import { test } from "../../../testing/mod.ts";
import { toolkit as ptBRToolkit } from "../pt-br/toolkit.ts";
import { Checkbox } from "../toolkit/checkbox.tsx";
import { ConfirmDialog, type ConfirmOptions, useConfirm } from "../toolkit/confirm-dialog.tsx";
import { DatePicker } from "../toolkit/date-picker.tsx";
import { DateTimePicker } from "../toolkit/date-time-picker.tsx";
import { Dialog } from "../toolkit/dialog.tsx";
import { Field } from "../toolkit/field.tsx";
import { useFormSubmit } from "../toolkit/form.tsx";
import { Input } from "../toolkit/input.tsx";
import { useModal } from "../toolkit/modal.ts";
import { MultiPicker, Picker } from "../toolkit/picker.tsx";
import { Radio } from "../toolkit/radio.tsx";
import { type RecordChange, RecordDialog, type RecordForm } from "../toolkit/record-dialog.tsx";
import { Select } from "../toolkit/select.tsx";
import { Switch } from "../toolkit/switch.tsx";
import { TagsInput } from "../toolkit/tags-input.tsx";
import { Textarea } from "../toolkit/textarea.tsx";
import { dismissToast, toastState } from "../toolkit/toast-state.ts";
import { setWords } from "../words.ts";
import { page } from "./page.ts";

type Customer = {
  name: string;
  email?: string;
  nickname?: string | null;
  price?: number;
  active?: boolean;
  createdAt?: string;
};

const ANA = {
  _id: "A",
  name: "Ana",
  email: "a@example.com",
  nickname: null,
  price: 24,
  createdAt: "2026-11-01 09:00",
};
const BO = { _id: "B", name: "Bo", email: "b@example.com", nickname: "Bobby", price: 3 };

// ---- helpers

/** The toasts shown since the last look, taken away (their timers too). */
function toasts(): string[] {
  const shown = toastState().toasts;
  for (const t of shown) dismissToast(t.id);
  return shown.map((t) => `${t.tone}:${String(t.message)}`);
}

const dialog = () => document.querySelector("dialog");
const input = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const button = (words: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === words)!;
const alert = () => document.querySelector('[role="alert"]')?.textContent ?? null;
const notes = () =>
  [...document.querySelectorAll(".copilotz-field-error")].map((note) => note.textContent);
const submit = () => act(async () => document.querySelector("form")!.requestSubmit());
const click = (element: HTMLElement) => act(async () => element.click());
const settle = (resolve: () => void) => act(async () => resolve());

/** Change the control as typing does, before React handles the input event. */
function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}

/** Escape, as a browser does it once the dialog lets it go: a cancel event, then it closes. */
function escape() {
  return act(() => {
    const cancel = new window.Event("cancel", { cancelable: true });
    dialog()!.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) dialog()!.close();
    return Promise.resolve(cancel.defaultPrevented);
  });
}

/** A press that starts and ends on the backdrop. */
const backdrop = () =>
  act(() => {
    dialog()!.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    dialog()!.click();
  });

function Upload({ wait, file = "A.pdf" }: { wait: Promise<void>; file?: string }) {
  useFormSubmit(async () => {
    await wait;
    return { file };
  });
  return null;
}

/** Name, email and nickname as text, and the price as a number. */
const fields = (form: RecordForm<Customer>, more?: ReactNode) => (
  <>
    <Field label="Name" error={form.error("name")}>
      {(c) => <Input {...c} {...form.text("name")} />}
    </Field>
    <Field label="Email" error={form.error("email")}>
      {(c) => <Input {...c} {...form.text("email")} />}
    </Field>
    <Field label="Nickname">{(c) => <Input {...c} {...form.text("nickname")} />}</Field>
    <Field label="Price" error={form.error("price")}>
      {(c) => <Input {...c} {...form.number("price")} />}
    </Field>
    {more}
  </>
);

// ---- the record dialog: what a save sends

test("R1, R2: only edits are sent, over the record as it is now", () =>
  page(async (render) => {
    const changes: RecordChange<Customer>[] = [];
    const edit = (record: typeof ANA) =>
      render(
        <RecordDialog<Customer>
          title="Customer"
          record={record}
          onSave={(change) => {
            changes.push(change);
          }}
          onClose={() => {}}
        >
          {(form) => fields(form)}
        </RecordDialog>,
      );
    await edit(ANA);
    assert.equal(input("nickname").value, "");
    await typeInto(input("name"), "Ana Silva");
    // The same record, read again: someone else changed the email.
    await edit({ ...ANA, email: "ana@example.com" });
    assert.equal(input("email").value, "ana@example.com");
    assert.equal(input("name").value, "Ana Silva");
    await submit();
    assert.deepEqual(changes, [{
      kind: "update",
      _id: "A",
      set: { name: "Ana Silva" },
      unset: [],
      update: { $set: { name: "Ana Silva" } },
      record: { ...ANA, email: "ana@example.com" },
    }]);
  }));

test("R3, R4: a cleared number is an unset; each binder saves its control's value", () =>
  page(async (render) => {
    const changes: RecordChange<Record<string, unknown>>[] = [];
    await render(
      <RecordDialog
        title="Item"
        record={{
          _id: "i1",
          price: 0,
          paid: false,
          plan: "month",
          tags: ["a"],
          note: "Old",
          due: "2026-11-25",
        }}
        onSave={(change) => {
          changes.push(change);
        }}
        onClose={() => {}}
      >
        {(form) => (
          <>
            <Input {...form.number("price")} />
            <Checkbox label="Paid" {...form.checked("paid")} />
            <Radio label="Monthly" {...form.radio("plan", "month")} />
            <Radio label="Yearly" {...form.radio("plan", "year")} />
            <Textarea {...form.text("note")} />
            <TagsInput label="Tags" name="tags" {...form.list("tags")} />
            <button type="button" onClick={() => form.set("due", undefined)}>Clear due</button>
            <span id="due">{String(form.get("due"))}</span>
            <span id="shown">{JSON.stringify(form.record)}</span>
          </>
        )}
      </RecordDialog>,
    );
    assert.equal(input("price").value, "0");
    assert.equal(input("price").type, "number");
    await typeInto(input("price"), "");
    await click(input("paid"));
    await click(document.querySelectorAll<HTMLInputElement>('input[name="plan"]')[1]);
    await typeInto(document.querySelector("textarea")!, "New");
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Remove a"]')!);
    await click(button("Clear due"));
    assert.equal(document.querySelector("#due")!.textContent, "undefined");
    assert.deepEqual(JSON.parse(document.querySelector("#shown")!.textContent!), {
      _id: "i1",
      paid: true,
      plan: "year",
      tags: [],
      note: "New",
    });
    await submit();
    assert.deepEqual(changes[0].kind === "update" && changes[0].update, {
      $set: { paid: true, plan: "year", note: "New", tags: [] },
      $unset: { price: "", due: "" },
    });
  }));

test("R5: a new record is its defaults with the edits, though they're drawn anew each time", () =>
  page(async (render) => {
    const changes: RecordChange<Customer>[] = [];
    const draw = () =>
      render(
        <RecordDialog<Customer>
          title="New customer"
          defaults={{ price: 5, nickname: null, email: "x@example.com" }}
          onSave={(change) => {
            changes.push(change);
          }}
          onClose={() => {}}
        >
          {(form) => fields(form, <Upload wait={Promise.resolve()} file="card.pdf" />)}
        </RecordDialog>,
      );
    await draw();
    assert.equal(input("price").value, "5");
    await typeInto(input("name"), "Cy");
    await draw();
    await typeInto(input("email"), "");
    assert.equal(input("name").value, "Cy");
    await submit();
    assert.deepEqual(changes, [{
      kind: "create",
      values: { price: 5, nickname: null, name: "Cy", file: "card.pdf" },
    }]);
  }));

test("R6: a save with nothing changed closes, saving nothing and saying nothing", () =>
  page(async (render) => {
    toasts();
    let saved = 0;
    let closed = 0;
    await render(
      <RecordDialog<Customer>
        title="Customer"
        record={ANA}
        toast="Saved."
        onSave={() => {
          saved++;
        }}
        onClose={() => closed++}
      >
        {(form) => fields(form)}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ann");
    await typeInto(input("name"), "Ana");
    await submit();
    assert.deepEqual({ saved, closed, toasts: toasts() }, { saved: 0, closed: 1, toasts: [] });
  }));

const items = (_: unknown, ctx: ViewContext) => ctx.db.collection<Customer>("item");

test("R7: a View's collection takes the change: an unset removes, an insert adds, a refusal shows by its field", async () => {
  const store = memoryStore();
  const runtime = await createRuntime({
    store,
    plugins: [definePlugin({
      name: "items",
      collections: {
        item: {
          schema: {
            type: "object",
            properties: {
              name: { type: "string", minLength: 3 },
              price: { type: "number" },
              email: { type: "string" },
              nickname: { type: ["string", "null"] },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      guard: (_actor, { collection }) => collection === "item" ? {} : undefined,
      views: { items },
    })],
  });
  try {
    const view = runtime.observe<ReturnType<typeof items>>("items", {}, {
      actor: { kind: "person", id: "ana" },
    });
    const ready = await view.ready;
    assert(ready.status === "ready");
    const customers = ready.value;
    const { insertedId } = await customers.insertOne({ name: "Pen", price: 24 });
    let saving: Promise<unknown> = Promise.resolve();
    let closed = 0;
    const save = (change: RecordChange<Customer>) =>
      saving = change.kind === "create"
        ? customers.insertOne(change.values)
        : customers.updateOne({ _id: change._id }, change.update);
    await page(async (render) => {
      const draw = (record?: Customer & { _id: string }) =>
        render(
          <RecordDialog<Customer>
            title="Item"
            record={record}
            errors={{ name: "Give the whole name." }}
            onSave={save}
            onClose={() => closed++}
          >
            {(form) => fields(form)}
          </RecordDialog>,
        );
      await draw({ _id: insertedId, name: "Pen", price: 24 });
      await typeInto(input("price"), "");
      await submit();
      await act(async () => void await saving);
      assert.deepEqual(await store.findOne("item", { _id: insertedId }), {
        _id: insertedId,
        name: "Pen",
      });
      assert.equal(closed, 1);

      await draw({ _id: insertedId, name: "Pen" });
      await typeInto(input("name"), "Pe");
      await submit();
      await act(async () => void await saving.catch(() => {}));
      assert.deepEqual(notes(), ["Give the whole name."]);
      assert.equal(closed, 1);

      await draw(undefined);
      await typeInto(input("name"), "Pencil");
      await typeInto(input("price"), "2.5");
      await submit();
      let made = "";
      await act(async () => void ({ insertedId: made } = await saving as { insertedId: string }));
      assert.deepEqual(await store.findOne("item", { _id: made }), {
        _id: made,
        name: "Pencil",
        price: 2.5,
      });
      assert.equal(closed, 2);
    });
  } finally {
    await runtime.close();
  }
});

// ---- the record dialog: sessions and attempts

test("R8: switched to another record mid-save, the first saves on its own record, and closes nothing", () =>
  page(async (render) => {
    toasts();
    const upload = Promise.withResolvers<void>();
    const saves: [string, RecordChange<Customer>][] = [];
    const closed: string[] = [];
    const edit = (record: typeof ANA | typeof BO) =>
      render(
        <RecordDialog<Customer>
          title={record.name}
          record={record}
          toast={`${record.name} saved.`}
          onSave={(change) => {
            saves.push([record._id, change]);
          }}
          onClose={() => closed.push(record._id)}
        >
          {(form) => fields(form, <Upload wait={upload.promise} />)}
        </RecordDialog>,
      );
    await edit(ANA);
    await typeInto(input("name"), "Ana Silva");
    await submit();
    assert.equal(dialog()!.getAttribute("aria-busy"), "true");
    await edit(BO);
    assert.equal(input("name").value, "Bo");
    assert.equal(dialog()!.getAttribute("aria-busy"), null);
    assert.equal(button("Save").disabled, false);
    await settle(upload.resolve);
    assert.deepEqual(saves, [["A", {
      kind: "update",
      _id: "A",
      set: { name: "Ana Silva", file: "A.pdf" },
      unset: [],
      update: { $set: { name: "Ana Silva", file: "A.pdf" } },
      record: ANA,
    }]]);
    assert.deepEqual(closed, []);
    assert.deepEqual(toasts(), ["success:Ana saved."]);
    assert.equal(input("name").value, "Bo");
  }));

test("R9: closed or gone mid-save, it saves all the same; its outcome is a toast", () =>
  page(async (render) => {
    toasts();
    const saves: string[] = [];
    const closed: string[] = [];
    for (
      const [how, fails] of [["unmounted", false], ["closed", false], ["closed", true]] as const
    ) {
      const upload = Promise.withResolvers<void>();
      const draw = (open: boolean) =>
        render(
          <RecordDialog<Customer>
            title="Ana"
            open={open}
            record={ANA}
            toast="Saved."
            onSave={(change) => {
              saves.push(change.kind === "update" ? JSON.stringify(change.set) : "create");
              if (fails) throw new Error("The server is away.");
            }}
            onClose={() => closed.push(how)}
          >
            {(form) => fields(form, <Upload wait={upload.promise} />)}
          </RecordDialog>,
        );
      await draw(true);
      await typeInto(input("name"), `Ana ${how}`);
      await submit();
      await (how === "unmounted" ? render(null) : draw(false));
      assert.equal(dialog(), null);
      await settle(upload.resolve);
    }
    assert.deepEqual(saves, [
      '{"name":"Ana unmounted","file":"A.pdf"}',
      '{"name":"Ana closed","file":"A.pdf"}',
      '{"name":"Ana closed","file":"A.pdf"}',
    ]);
    assert.deepEqual(closed, []);
    assert.deepEqual(toasts(), [
      "success:Saved.",
      "success:Saved.",
      "destructive:The server is away.",
    ]);
  }));

test("R10: what's typed while a part works is in the save", () =>
  page(async (render) => {
    const upload = Promise.withResolvers<void>();
    const saves: unknown[] = [];
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={(change) => {
          saves.push(change.kind === "update" && change.set);
        }}
        onClose={() => {}}
      >
        {(form) => fields(form, <Upload wait={upload.promise} />)}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana S");
    await submit();
    await typeInto(input("name"), "Ana Silva");
    await settle(upload.resolve);
    assert.deepEqual(saves, [{ name: "Ana Silva", file: "A.pdf" }]);
  }));

test("R11: busy, it can't be dismissed, and a second Save does nothing", () =>
  page(async (render) => {
    const save = Promise.withResolvers<void>();
    let saved = 0;
    let closed = 0;
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={() => {
          saved++;
          return save.promise;
        }}
        onClose={() => closed++}
      >
        {(form) => fields(form)}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana S");
    await submit();
    assert.equal(dialog()!.getAttribute("aria-busy"), "true");
    assert.equal(dialog()!.getAttribute("closedby"), "none");
    assert.equal(button("Save").getAttribute("aria-busy"), "true");
    assert.equal(button("Save").disabled, true);
    assert.equal(button("Cancel").disabled, true);
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.disabled, true);
    assert.equal(await escape(), true);
    await backdrop();
    await submit();
    assert.equal(dialog()!.open, true);
    assert.deepEqual({ saved, closed }, { saved: 1, closed: 0 });
    await settle(save.resolve);
    assert.deepEqual({ saved, closed }, { saved: 1, closed: 1 });
  }));

test("R12: a refusal shows under its field, in people's words, or at the form's top", () =>
  page(async (render) => {
    let refusal: unknown;
    const refuse = (field: string | undefined, message: string) =>
      refusal = Object.assign(new Error(message), field ? { detail: { field } } : {});
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        errors={{ email: "That email address isn't complete." }}
        onSave={() => Promise.reject(refusal)}
        onClose={() => {}}
      >
        {(form) =>
          fields(
            form,
            <>
              <Field label="Lines" error={form.error("lines")}>
                {(c) => <Input {...c} name="lines" />}
              </Field>
              <Fail />
            </>,
          )}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana S");

    refuse("email", 'item: must match format "email" (#/email)');
    await submit();
    assert.deepEqual(notes(), ["That email address isn't complete."]);
    assert.equal(alert(), null);
    assert.ok(document.activeElement === input("email"), "focus on input(email)");
    assert.equal(input("email").getAttribute("aria-invalid"), "true");

    refuse("price", "item: must be number (#/price)");
    await submit();
    assert.deepEqual(notes(), ["item: must be number (#/price)"]);
    assert.ok(document.activeElement === input("price"), "focus on input(price)");

    refuse("lines.0.qty", "Give a quantity.");
    await submit();
    assert.deepEqual(notes(), ["Give a quantity."]);

    refuse("code", "That code is taken.");
    // Save, pressed, waits disabled: the focus it had is lost until the refusal gives it back.
    (document.activeElement as HTMLElement).blur();
    await submit();
    assert.deepEqual(notes(), []);
    assert.equal(alert(), "That code is taken.");
    assert.ok(document.activeElement === button("Save"), "focus on button(Save)");

    refuse(undefined, "");
    await submit();
    assert.equal(alert(), "It wasn't saved. Try again.");

    failing = true;
    await submit();
    assert.equal(alert(), "The scan didn't upload.");
    failing = false;
  }));

let failing = false;
function Fail() {
  useFormSubmit(() => {
    if (failing) throw new Error("The scan didn't upload.");
  });
  return null;
}

test("R13: refusals clear with a new attempt, an edit of their field, and a new session", () =>
  page(async (render) => {
    let words = "First words.";
    let sync = false;
    const draw = (record: typeof ANA | typeof BO, open = true) =>
      render(
        <RecordDialog<Customer>
          title={record.name}
          open={open}
          record={record}
          onSave={() => {
            const refusal = Object.assign(new Error(words), { detail: { field: "email" } });
            if (sync) throw refusal;
            return Promise.reject(refusal);
          }}
          onClose={() => {}}
        >
          {(form) => fields(form)}
        </RecordDialog>,
      );
    await draw(ANA);
    await typeInto(input("name"), "Ana S");
    await submit();
    assert.deepEqual(notes(), ["First words."]);
    words = "Second words.";
    sync = true;
    await submit();
    assert.deepEqual(notes(), ["Second words."]);
    await typeInto(input("email"), "ana@example.com");
    assert.deepEqual(notes(), []);
    await submit();
    assert.deepEqual(notes(), ["Second words."]);
    // Closed and opened again: a new session, with no refusal and no edits.
    await draw(ANA, false);
    await draw(ANA);
    assert.deepEqual(notes(), []);
    assert.equal(input("name").value, "Ana");
    await typeInto(input("name"), "Ana S");
    await submit();
    assert.deepEqual(notes(), ["Second words."]);
    // Another record: A's refusal never shows on B.
    await draw(BO);
    assert.deepEqual(notes(), []);
  }));

test("R14: onClose once for each close the person makes or a save ends; none for the owner's", () =>
  page(async (render) => {
    toasts();
    const closed: string[] = [];
    let save = Promise.withResolvers<void>();
    const draw = (how: string, open = true) =>
      render(
        <RecordDialog<Customer>
          key={how}
          title="Ana"
          open={open}
          record={ANA}
          toast="Saved."
          onSave={() => save.promise}
          onClose={() => closed.push(`${how}:${toasts().join()}`)}
        >
          {(form) => fields(form)}
        </RecordDialog>,
      );
    await draw("saved");
    await typeInto(input("name"), "Ana S");
    await submit();
    await settle(save.resolve);
    await draw("cancel");
    await click(button("Cancel"));
    await draw("escape");
    await escape();
    await draw("close");
    await click(document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!);
    await draw("backdrop");
    await backdrop();
    await draw("owner");
    await draw("owner", false);
    await draw("owner");
    await render(null);
    assert.deepEqual(closed, [
      "saved:success:Saved.",
      "cancel:",
      "escape:",
      "close:",
      "backdrop:",
    ]);

    // The browser closes it while busy (a second Escape it won't hold): that's a close.
    closed.length = 0;
    save = Promise.withResolvers<void>();
    await draw("forced");
    await typeInto(input("name"), "Ana S");
    await submit();
    await act(() => dialog()!.close());
    assert.deepEqual(closed, ["forced:"]);
    await settle(save.resolve);
    assert.deepEqual(closed, ["forced:"]);
    assert.deepEqual(toasts(), ["success:Saved."]);
  }));

test("R15: focus goes into the dialog, and back to what opened it", () =>
  page(async (render) => {
    let other: HTMLButtonElement | null = null;
    function Screen({ moveOn }: { moveOn?: boolean }) {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" id="opener" onClick={() => setOpen(true)}>Edit</button>
          <button type="button" id="other" ref={(b) => void (other = b)}>Other</button>
          <RecordDialog<Customer>
            title="Ana"
            open={open}
            record={ANA}
            onSave={() => {}}
            onClose={() => {
              setOpen(false);
              if (moveOn) other!.focus();
            }}
          >
            {(form) => fields(form)}
          </RecordDialog>
        </>
      );
    }
    const opener = () => document.querySelector<HTMLButtonElement>("#opener")!;
    await render(<Screen />);
    opener().focus();
    await click(opener());
    // In the dialog: a browser gives it to the first field (happy-dom can't read useModal's
    // selector past the header, so it gives it to ×).
    assert.ok(dialog()!.contains(document.activeElement), "focus in the dialog");
    await click(button("Cancel"));
    assert.equal(dialog(), null);
    assert.ok(document.activeElement === opener(), "focus on opener()");

    await render(<Screen key="2" moveOn />);
    opener().focus();
    await click(opener());
    await click(button("Cancel"));
    assert.ok(document.activeElement === other, "focus on other");
  }));

// ---- confirmations

function Asker({ ask }: { ask: (confirm: (q: ConfirmOptions) => Promise<boolean>) => void }) {
  const [dialog, confirm] = useConfirm();
  return (
    <>
      <button type="button" id="ask" onClick={() => ask(confirm)}>Ask</button>
      {dialog}
    </>
  );
}

test("C1, C2: a confirmation: cancelled, it closes; confirmed, it's busy until done", () =>
  page(async (render) => {
    toasts();
    const closed: string[] = [];
    let ran = 0;
    let work = Promise.withResolvers<void>();
    const show = (key: string) =>
      render(
        <ConfirmDialog
          key={key}
          title="Delete Ana Silva?"
          message="Her visits stay."
          danger
          toast="Customer deleted."
          onConfirm={() => {
            ran++;
            return work.promise;
          }}
          onClose={() => closed.push(key)}
        />,
      );
    await show("cancel");
    await click(button("Cancel"));
    await show("escape");
    await escape();
    await show("backdrop");
    await backdrop();
    assert.deepEqual({ closed, ran }, { closed: ["cancel", "escape", "backdrop"], ran: 0 });

    closed.length = 0;
    await show("delete");
    await click(button("Delete"));
    await click(button("Delete"));
    assert.equal(ran, 1);
    assert.equal(dialog()!.getAttribute("aria-busy"), "true");
    assert.equal(button("Delete").getAttribute("aria-busy"), "true");
    assert.equal(button("Cancel").disabled, true);
    assert.equal(await escape(), true);
    await backdrop();
    assert.deepEqual(closed, []);
    await settle(work.resolve);
    assert.deepEqual(closed, ["delete"]);
    assert.deepEqual(toasts(), ["success:Customer deleted."]);

    // With the hook: false when cancelled, true once done.
    const answers: boolean[] = [];
    work = Promise.withResolvers<void>();
    await render(
      <Asker
        ask={(confirm) =>
          void confirm({
            title: "Archive Bo?",
            onConfirm: () => work.promise,
          }).then((yes) => answers.push(yes))}
      />,
    );
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    await click(button("Cancel"));
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    await click(button("Confirm"));
    assert.equal(button("Confirm").getAttribute("aria-busy"), "true");
    await settle(work.resolve);
    assert.deepEqual(answers, [false, true]);
    assert.equal(dialog(), null);
  }));

test("C3: a failure says why and stays, to try again or cancel", () =>
  page(async (render) => {
    let ran = 0;
    let fail: unknown = new Error("She still has open invoices.");
    const answers: boolean[] = [];
    await render(
      <Asker
        ask={(confirm) =>
          void confirm({
            title: "Delete Ana Silva?",
            danger: true,
            onConfirm: () => {
              ran++;
              if (fail) return Promise.reject(fail);
            },
          }).then((yes) => answers.push(yes))}
      />,
    );
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    await click(button("Delete"));
    assert.equal(alert(), "She still has open invoices.");
    assert.equal(dialog()!.open, true);
    assert.equal(dialog()!.getAttribute("aria-busy"), null);
    assert.equal(button("Cancel").disabled, false);
    assert.ok(document.activeElement === button("Cancel"), "focus on button(Cancel)");
    fail = {};
    await click(button("Delete"));
    assert.equal(alert(), "It wasn't done. Try again.");
    assert.equal(ran, 2);
    await click(button("Cancel"));
    assert.deepEqual(answers, [false]);
  }));

test("C4: a delete's words and focus; a plain question's; an alertdialog; in Portuguese too", () =>
  page(async (render) => {
    await render(
      <ConfirmDialog
        title="Delete Ana Silva?"
        message="Her visits stay."
        danger
        onConfirm={() => {}}
        onClose={() => {}}
      >
        <ul>
          <li>3 visits</li>
        </ul>
      </ConfirmDialog>,
    );
    const asking = dialog()!;
    assert.equal(asking.getAttribute("role"), "alertdialog");
    assert.equal(
      document.getElementById(asking.getAttribute("aria-labelledby")!)!.textContent,
      "Delete Ana Silva?",
    );
    assert.equal(
      document.getElementById(asking.getAttribute("aria-describedby")!)!.textContent,
      "Her visits stay.",
    );
    assert.match(asking.textContent!, /3 visits/);
    assert.match(button("Delete").className, /copilotz-button-destructive/);
    assert.ok(document.activeElement === button("Cancel"), "focus on button(Cancel)");

    await render(
      <ConfirmDialog key="2" title="Send the invoice?" onConfirm={() => {}} onClose={() => {}} />,
    );
    assert.match(button("Confirm").className, /copilotz-button-primary/);
    assert.ok(document.activeElement === button("Confirm"), "focus on button(Confirm)");
    assert.equal(dialog()!.getAttribute("aria-describedby"), null);

    const restore = setWords(ptBRToolkit);
    try {
      await render(
        <ConfirmDialog key="3" title="Excluir?" danger onConfirm={() => {}} onClose={() => {}} />,
      );
      assert.ok(button("Excluir") && button("Cancelar"));
      await render(
        <ConfirmDialog key="4" title="Enviar?" onConfirm={() => {}} onClose={() => {}} />,
      );
      assert.ok(button("Confirmar"));
    } finally {
      restore();
    }
  }));

test("C5: questions show one at a time, in order; confirm is the same function on every render", () =>
  page(async (render) => {
    const confirms: unknown[] = [];
    const answers: string[] = [];
    function Owner({ n }: { n: number }) {
      const [dialog, confirm] = useConfirm();
      confirms.push(confirm);
      return (
        <>
          <span>{n}</span>
          <button
            type="button"
            id="ask"
            onClick={() => {
              for (const name of ["Ana", "Bo"]) {
                void confirm({ title: `Delete ${name}?` }).then((yes) =>
                  answers.push(`${name} ${yes}`)
                );
              }
            }}
          >
            Ask
          </button>
          {dialog}
        </>
      );
    }
    await render(<Owner n={1} />);
    await render(<Owner n={2} />);
    assert.equal(confirms[0], confirms.at(-1));
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    assert.equal(document.querySelectorAll("dialog").length, 1);
    assert.match(dialog()!.textContent!, /Delete Ana\?/);
    await click(button("Confirm"));
    assert.match(dialog()!.textContent!, /Delete Bo\?/);
    assert.ok(document.activeElement === button("Confirm"), "focus on button(Confirm)");
    await click(button("Cancel"));
    assert.equal(dialog(), null);
    assert.deepEqual(answers, ["Ana true", "Bo false"]);
  }));

test("C6: when the owner goes, its questions say no, a running one how it ended, and none comes back", () =>
  page(async (render) => {
    toasts();
    const work = Promise.withResolvers<void>();
    const answers: string[] = [];
    let later: ((q: ConfirmOptions) => Promise<boolean>) | undefined;
    await render(
      <Asker
        ask={(confirm) => {
          later = confirm;
          void confirm({
            title: "Delete Ana?",
            toast: "Ana deleted.",
            onConfirm: () => work.promise,
          })
            .then((yes) => answers.push(`Ana ${yes}`));
          void confirm({ title: "Delete Bo?" }).then((yes) => answers.push(`Bo ${yes}`));
        }}
      />,
    );
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    await click(button("Confirm"));
    await render(null);
    assert.deepEqual(answers, ["Bo false"]);
    await settle(work.resolve);
    assert.deepEqual(answers, ["Bo false", "Ana true"]);
    assert.deepEqual(toasts(), ["success:Ana deleted."]);
    assert.equal(await later!({ title: "Delete Cy?" }), false);
    await render(<Asker ask={() => {}} />);
    assert.equal(dialog(), null);

    // A component that never draws its dialog: asking is a mistake, said at once.
    let lost: ((q: ConfirmOptions) => Promise<boolean>) | undefined;
    function Forgetful() {
      const [, confirm] = useConfirm();
      useEffect(() => void (lost = confirm), [confirm]);
      return null;
    }
    await render(<Forgetful />);
    await assert.rejects(lost!({ title: "Delete?" }), /\{dialog\}/);
  }));

test("C7: a question is one element, open once: a reopened or re-keyed one isn't closed by the first", () =>
  page(async (render) => {
    toasts();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const closed: string[] = [];
    const show = (key: string, title: string, work: Promise<void>, open = true) =>
      render(
        <ConfirmDialog
          key={key}
          title={title}
          open={open}
          toast={`${title} done.`}
          onConfirm={() => work}
          onClose={() => closed.push(title)}
        />,
      );
    // Closed and opened again.
    await show("q", "A", first.promise);
    await click(button("Confirm"));
    await show("q", "A", first.promise, false);
    await show("q", "B", second.promise);
    await click(button("Confirm"));
    await settle(first.resolve);
    assert.deepEqual(closed, []);
    assert.equal(dialog()!.getAttribute("aria-busy"), "true");
    await settle(second.resolve);
    assert.deepEqual(closed, ["B"]);
    assert.deepEqual(toasts(), ["success:A done.", "success:B done."]);

    // Replaced, still open, by a new key.
    closed.length = 0;
    const third = Promise.withResolvers<void>();
    await show("C", "C", third.promise);
    await click(button("Confirm"));
    await show("D", "D", Promise.resolve());
    assert.equal(dialog()!.getAttribute("aria-busy"), null);
    await settle(third.resolve);
    assert.deepEqual(closed, []);
    assert.match(dialog()!.textContent!, /D/);
    assert.deepEqual(toasts(), ["success:C done."]);
  }));

test("C8: closed by the browser while busy: a close, and the operation ends on its own", () =>
  page(async (render) => {
    toasts();
    const work = Promise.withResolvers<void>();
    const closed: string[] = [];
    await render(
      <ConfirmDialog
        title="Delete Ana?"
        toast="Ana deleted."
        onConfirm={() => work.promise}
        onClose={() => closed.push("closed")}
      />,
    );
    await click(button("Confirm"));
    await act(() => dialog()!.close());
    assert.deepEqual(closed, ["closed"]);
    await settle(work.resolve);
    assert.deepEqual(closed, ["closed"]);
    assert.deepEqual(toasts(), ["success:Ana deleted."]);

    // With the hook, the next question shows, and the first is answered by its end.
    const fails = Promise.withResolvers<void>();
    const answers: string[] = [];
    await render(
      <Asker
        ask={(confirm) => {
          void confirm({ title: "Delete Ana?", onConfirm: () => fails.promise })
            .then((yes) => answers.push(`Ana ${yes}`));
          void confirm({ title: "Delete Bo?" }).then((yes) => answers.push(`Bo ${yes}`));
        }}
      />,
    );
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    await click(button("Confirm"));
    await act(() => dialog()!.close());
    assert.match(dialog()!.textContent!, /Delete Bo\?/);
    await settle(() => fails.reject(new Error("Ana has invoices.")));
    assert.deepEqual(answers, ["Ana false"]);
    assert.deepEqual(toasts(), ["destructive:Ana has invoices."]);
    assert.match(dialog()!.textContent!, /Delete Bo\?/);
  }));

// ---- Dialog's new props

test("Dialog busy, role and aria-describedby; useModal keep", () =>
  page(async (render) => {
    let keys: string[] = [];
    function Modal() {
      const { events } = useModal(true, () => {}, { keep: true });
      keys = Object.keys(events);
      return null;
    }
    await render(<Modal />);
    assert.deepEqual(keys, ["onClose", "onCancel", "onPointerDown", "onClick"]);
    await render(
      <Dialog open onClose={() => {}} title="Ask" role="alertdialog" aria-describedby="said" busy>
        <p id="said">Sure?</p>
      </Dialog>,
    );
    assert.equal(dialog()!.getAttribute("role"), "alertdialog");
    assert.equal(dialog()!.getAttribute("aria-describedby"), "said");
    assert.equal(dialog()!.getAttribute("aria-busy"), "true");
    assert.equal(dialog()!.getAttribute("closedby"), "none");
  }));

// ---- types: the docs' examples compile (checked, never run)

export function typed(customers: Collection<Customer>, ana: Customer & { _id: string }) {
  return (
    <RecordDialog<Customer>
      title={ana.name}
      record={ana}
      onSave={(change) =>
        change.kind === "create"
          ? customers.insertOne(change.values)
          : customers.updateOne({ _id: change._id }, change.update)}
      onClose={() => {}}
    >
      {(form) => (
        <>
          <Input {...form.text("name")} />
          <Textarea {...form.text("note")} />
          <Select {...form.text("plan")}>
            <option value="month">Monthly</option>
          </Select>
          <Input {...form.number("price")} min={0} />
          <Checkbox label="Active" {...form.checked("active")} />
          <Switch label="Active" {...form.checked("active")} />
          <Radio label="Monthly" {...form.radio("plan", "month")} />
          <Picker
            label="Plan"
            options={[{ value: "month", label: "Monthly" }]}
            {...form.value("plan")}
          />
          <DatePicker label="Since" {...form.value("since")} />
          <DateTimePicker label="Opened" {...form.value("opened")} />
          <TagsInput label="Tags" {...form.list("tags")} />
          <MultiPicker
            label="Days"
            options={[{ value: "mon", label: "Mon" }]}
            {...form.list("days")}
          />
        </>
      )}
    </RecordDialog>
  );
}
