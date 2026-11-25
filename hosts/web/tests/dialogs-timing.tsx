/**
 * The dialogs against time: a render React doesn't commit, a session that ended but is still on
 * the screen, typing while a save runs, a dialog inside another, and the browser's `close` event
 * arriving after an operation ended. Each test is a reproduction from a review, then the rule
 * that closes its class. And the rest of that review: two hosts, a required field cleared during
 * a part, what a part hands back, paths through lists, copies of dates, focus after a question
 * asked from a question, and the binders' types.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { act, type ReactNode, startTransition, Suspense, use, useState } from "react";
import { test } from "../../../testing/mod.ts";
import { ConfirmDialog, type ConfirmOptions, useConfirm } from "../toolkit/confirm-dialog.tsx";
import { Field } from "../toolkit/field.tsx";
import { useFormSubmit } from "../toolkit/form.tsx";
import { Input } from "../toolkit/input.tsx";
import { type RecordChange, RecordDialog, type RecordForm } from "../toolkit/record-dialog.tsx";
import { createOf, same, updateOf, withValue } from "../toolkit/record-draft.ts";
import { dismissToast, toastState } from "../toolkit/toast-state.ts";
import { page } from "./page.ts";

type Customer = { name: string; email?: string; tags?: string[] | null; lines?: unknown };
const ANA = { _id: "A", name: "Ana", email: "a@example.com" };

function toasts(): string[] {
  const shown = toastState().toasts;
  for (const t of shown) dismissToast(t.id);
  return shown.map((t) => `${t.tone}:${String(t.message)}`);
}
const dialogs = () => [...document.querySelectorAll("dialog")];
const input = (name: string, scope: ParentNode = document) =>
  scope.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const button = (words: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === words)!;
const click = (element: HTMLElement) => act(async () => element.click());
const settle = (run: () => void) => act(async () => run());
const submit = (form = document.querySelector("form")!) => act(async () => form.requestSubmit());
function typeInto(element: HTMLInputElement, value: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
/** Escape as a browser does it: a cancel event, then the dialog closes if nothing refused it. */
const escape = (target: HTMLDialogElement) =>
  act(() => {
    const cancel = new window.Event("cancel", { cancelable: true });
    target.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) target.close();
    return Promise.resolve(cancel.defaultPrevented);
  });
const backdrop = (target: HTMLDialogElement) =>
  act(() => {
    target.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    target.click();
  });
/** The browser's close algorithm: the dialog is closed at once; its `close` event comes later. */
const closeQuietly = (target: HTMLDialogElement) => act(() => target.removeAttribute("open"));
const closeEvent = (target: HTMLDialogElement) =>
  act(() => void target.dispatchEvent(new window.Event("close")));

const fields = (form: RecordForm<Customer>, more?: ReactNode) => (
  <>
    <Field label="Name" error={form.error("name")}>
      {(c) => <Input {...c} {...form.text("name")} />}
    </Field>
    <Field label="Email" error={form.error("email")}>
      {(c) => <Input {...c} {...form.text("email")} />}
    </Field>
    {more}
  </>
);

function Upload({ wait, file = "A.pdf" }: { wait: Promise<void>; file?: string }) {
  useFormSubmit(async () => {
    await wait;
    return { file };
  });
  return null;
}

/** A child that suspends while `version` is 2: what React renders then, it doesn't commit. */
const never = new Promise<void>(() => {});
function Suspends({ version }: { version: number }) {
  if (version === 2) use(never);
  return null;
}

// ---- 1. A render React doesn't commit

test("H1: a suspended render doesn't change what the visible confirmation does", () =>
  page(async (render) => {
    toasts();
    const ran: string[] = [];
    const closed: string[] = [];
    let move = (_: number) => {};
    function Owner() {
      const [version, setVersion] = useState(1);
      move = (n) => startTransition(() => setVersion(n));
      return (
        <>
          <ConfirmDialog
            title={version === 1
              ? "Delete Ana, keep her invoices?"
              : "Delete Ana and her invoices?"}
            danger
            toast={`toast ${version}`}
            onConfirm={() => void ran.push(`delete ${version}`)}
            onClose={() => closed.push(`close ${version}`)}
          />
          <Suspends version={version} />
        </>
      );
    }
    await render(
      <Suspense fallback="…">
        <Owner />
      </Suspense>,
    );
    act(() => move(2));
    assert.equal(document.querySelector("h2")!.textContent, "Delete Ana, keep her invoices?");
    await click(button("Delete"));
    assert.deepEqual({ ran, closed, toasts: toasts() }, {
      ran: ["delete 1"],
      closed: ["close 1"],
      toasts: ["success:toast 1"],
    });
  }));

test("H1: a suspended render doesn't change what the visible record dialog saves", () =>
  page(async (render) => {
    const saves: string[] = [];
    let move = (_: number) => {};
    function Owner() {
      const [version, setVersion] = useState(1);
      move = (n) => startTransition(() => setVersion(n));
      // The refresh that suspends has the name already edited, and another onSave.
      const record = version === 1 ? ANA : { ...ANA, name: "Edited" };
      return (
        <>
          <RecordDialog<Customer>
            title="Ana"
            record={record}
            onSave={(change) => void saves.push(`${version} ${JSON.stringify(change)}`)}
            onClose={() => {}}
          >
            {(form) => fields(form)}
          </RecordDialog>
          <Suspends version={version} />
        </>
      );
    }
    await render(
      <Suspense fallback="…">
        <Owner />
      </Suspense>,
    );
    await typeInto(input("name"), "Edited");
    act(() => move(2));
    await submit();
    assert.equal(saves.length, 1);
    assert.match(saves[0], /^1 /);
    assert.match(saves[0], /"set":\{"name":"Edited"\}/);
  }));

test("class: no new component writes a ref or shared state as it renders", () => {
  const files = [
    "confirm-dialog.tsx",
    "record-dialog.tsx",
    "return-focus.ts",
  ].map((name) => [
    name,
    readFileSync(new URL(`../toolkit/${name}`, import.meta.url), "utf8"),
  ]);
  for (const [name, source] of files) {
    // A component's body is indented once: an assignment to `.current` there runs as it renders.
    assert.deepEqual(source.match(/^ {2}[\w.]+\.current = .*$/gm) ?? [], [], name);
  }
});

// ---- 2. A session that ended, still on the screen

test("H2: a confirmation that ended takes no more actions, and says it closed once", () =>
  page(async (render) => {
    toasts();
    const ends = {
      cancel: () => click(button("Cancel")),
      escape: () => escape(dialogs()[0]),
      confirm: () => click(button("Confirm")),
      failThenCancel: async () => {
        fail = true;
        await click(button("Confirm"));
        fail = false;
        await click(button("Cancel"));
      },
    };
    const actions = {
      cancel: () => click(button("Cancel")),
      confirm: () => click(button("Confirm")),
      escape: () => escape(dialogs()[0]),
      close: () => act(() => dialogs()[0].close()),
      backdrop: () => backdrop(dialogs()[0]),
    };
    let fail = false;
    for (const [end, finish] of Object.entries(ends)) {
      for (const [name, act2] of Object.entries(actions)) {
        let ran = 0;
        const closed: string[] = [];
        // The owner takes its time to close it: the question stays on the screen.
        await render(
          <ConfirmDialog
            key={`${end}-${name}`}
            title="Send the invoice?"
            onConfirm={() => {
              ran++;
              if (fail) throw new Error("No.");
            }}
            onClose={() => closed.push("closed")}
          />,
        );
        await finish();
        const before = ran;
        await act2();
        assert.deepEqual(
          { ran: ran - before, closed },
          { ran: 0, closed: ["closed"] },
          `${end}, then ${name}`,
        );
        toasts();
      }
    }
  }));

test("H2: a record dialog that ended takes no more saves or closes", () =>
  page(async (render) => {
    toasts();
    for (const end of ["saved", "cancelled", "unchanged", "escaped"]) {
      const saves: unknown[] = [];
      let closed = 0;
      await render(
        <RecordDialog<Customer>
          key={end}
          title="Customer"
          record={end === "saved" || end === "unchanged" ? ANA : undefined}
          onSave={(change) => void saves.push(change.kind)}
          onClose={() => closed++}
        >
          {(form) => fields(form)}
        </RecordDialog>,
      );
      if (end === "saved") await typeInto(input("name"), "Ana S");
      if (end === "saved" || end === "unchanged") await submit();
      if (end === "cancelled") await click(button("Cancel"));
      if (end === "escaped") await escape(dialogs()[0]);
      const before = saves.length;
      await typeInto(input("name"), "Again");
      await submit();
      await click(button("Cancel"));
      await escape(dialogs()[0]);
      await act(() => dialogs()[0].close());
      assert.deepEqual(
        { saves: saves.length - before, closed },
        { saves: 0, closed: 1 },
        end,
      );
      assert.equal(input("name").closest("fieldset")!.disabled, true, end);
      toasts();
    }
  }));

// ---- 3. Typing while the save runs

test("H3: editable while parts run, read-only while the save runs, editable again after a refusal", () =>
  page(async (render) => {
    const upload = Promise.withResolvers<void>();
    let save = Promise.withResolvers<void>();
    const saves: unknown[] = [];
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={(change) => {
          saves.push(change.kind === "update" && change.set);
          return save.promise;
        }}
        onClose={() => {}}
      >
        {(form) => fields(form, <Upload wait={upload.promise} />)}
      </RecordDialog>,
    );
    const locked = () => input("name").closest("fieldset")!.disabled;
    await typeInto(input("name"), "First");
    await submit();
    assert.equal(locked(), false);
    await typeInto(input("name"), "Second"); // during the part: in the save
    await settle(upload.resolve);
    assert.deepEqual(saves, [{ name: "Second", file: "A.pdf" }]);
    assert.equal(locked(), true);
    await typeInto(input("name"), "Third"); // during the save: refused
    assert.equal(input("name").value, "Second");
    await settle(() => save.reject(Object.assign(new Error("No."), { detail: { field: "name" } })));
    assert.equal(locked(), false);
    assert.equal(input("name").value, "Second");
    await typeInto(input("name"), "Fourth");
    save = Promise.withResolvers<void>();
    await submit();
    await settle(upload.resolve);
    assert.deepEqual(saves.at(-1), { name: "Fourth", file: "A.pdf" });
  }));

// ---- 4. A dialog inside another

test("H4: closing a confirmation inside a record dialog closes only the confirmation", () =>
  page(async (render) => {
    const closed: string[] = [];
    const upload = Promise.withResolvers<void>();
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={() => {}}
        onClose={() => closed.push("editor")}
      >
        {(form) =>
          fields(
            form,
            <>
              <Upload wait={upload.promise} />
              <ConfirmDialog
                title="Discard the scan?"
                onConfirm={() => {}}
                onClose={() => closed.push("question")}
              />
            </>,
          )}
      </RecordDialog>,
    );
    const [editor, question] = dialogs();
    await typeInto(input("name"), "Unsaved");
    await act(() => question.close());
    assert.deepEqual(closed, ["question"]);
    assert.equal(editor.open, true);
    assert.equal(input("name").value, "Unsaved");
    // Busy, the editor waits; Escape in the question is the question's.
    await submit(editor.querySelector("form")!);
    const cancel = new window.Event("cancel", { cancelable: true });
    question.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, false);
    await settle(upload.resolve);
  }));

test("H4: a record dialog inside another: its close and its submit stay its own", () =>
  page(async (render) => {
    const errors = console.error;
    console.error = (...args: unknown[]) => {
      // React says a form in a form isn't HTML: here it's the point of the test.
      if (!String(args[0]).includes("cannot be a descendant of")) errors(...args);
    };
    try {
      const said: string[] = [];
      await render(
        <RecordDialog<Customer>
          title="Order"
          record={ANA}
          onSave={() => void said.push("order saved")}
          onClose={() => said.push("order closed")}
        >
          {(form) =>
            fields(
              form,
              <RecordDialog<Customer>
                title="New customer"
                onSave={(change) => void said.push(`customer ${change.kind}`)}
                onClose={() => said.push("customer closed")}
              >
                {(inner) => (
                  <Field label="Customer">
                    {(c) => <Input {...c} {...inner.text("customer")} />}
                  </Field>
                )}
              </RecordDialog>,
            )}
        </RecordDialog>,
      );
      const [order, customer] = dialogs();
      await typeInto(input("customer"), "Cy");
      await submit(customer.querySelector("form")!);
      assert.deepEqual(said, ["customer create", "customer closed"]);
      await act(() => customer.close());
      assert.deepEqual(said, ["customer create", "customer closed"]);
      assert.equal(order.open, true);
    } finally {
      console.error = errors;
    }
  }));

// ---- 5. The browser's close event, after the operation ended

test("H5: closed by the browser, its close event still on the way: the outcome is a toast, onClose once", () =>
  page(async (render) => {
    toasts();
    // A record dialog's refusal.
    const closed: string[] = [];
    const save = Promise.withResolvers<void>();
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={() => save.promise}
        onClose={() => closed.push("editor")}
      >
        {(form) => fields(form)}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana S");
    await submit();
    const [editor] = dialogs();
    await closeQuietly(editor);
    await settle(() =>
      save.reject(Object.assign(new Error("Name refused."), { detail: { field: "name" } }))
    );
    assert.deepEqual(document.querySelectorAll(".copilotz-field-error").length, 0);
    assert.deepEqual(toasts(), ["destructive:Name refused."]);
    await closeEvent(editor);
    assert.deepEqual(closed, ["editor"]);

    // A confirmation that succeeds, in both orders.
    for (const order of ["settled first", "close event first"]) {
      closed.length = 0;
      const work = Promise.withResolvers<void>();
      await render(
        <ConfirmDialog
          key={order}
          title="Delete Ana?"
          toast="Deleted."
          onConfirm={() => work.promise}
          onClose={() => closed.push(order)}
        />,
      );
      await click(button("Confirm"));
      const [question] = dialogs();
      await closeQuietly(question);
      if (order === "close event first") await closeEvent(question);
      await settle(work.resolve);
      if (order === "settled first") await closeEvent(question);
      assert.deepEqual(closed, [order]);
      assert.deepEqual(toasts(), ["success:Deleted."]);
    }
  }));

// ---- Medium and low

function Host({ ask, places = ["one"] }: {
  ask: (confirm: (q: ConfirmOptions) => Promise<boolean>) => void;
  places?: string[];
}) {
  const [dialog, confirm] = useConfirm();
  return (
    <>
      <button type="button" id="ask" onClick={() => ask(confirm)}>Ask</button>
      {places.includes("one") ? <div id="one">{dialog}</div> : null}
      {places.includes("two") ? <div id="two">{dialog}</div> : null}
    </>
  );
}

test("M1: a question shown by a host that goes isn't shown again by another", () =>
  page(async (render) => {
    toasts();
    let ran = 0;
    const work = Promise.withResolvers<void>();
    const answers: string[] = [];
    const ask = (confirm: (q: ConfirmOptions) => Promise<boolean>) => {
      void confirm({
        title: "Delete Ana?",
        onConfirm: () => {
          ran++;
          return work.promise;
        },
      }).then((yes) => answers.push(`Ana ${yes}`));
      void confirm({ title: "Delete Bo?" }).then((yes) => answers.push(`Bo ${yes}`));
    };
    await render(<Host ask={ask} places={["one", "two"]} />);
    await click(document.querySelector<HTMLButtonElement>("#ask")!);
    assert.ok(document.querySelector("#one dialog"));
    assert.equal(document.querySelector("#two dialog"), null);
    await click(button("Confirm"));
    // The first {dialog} goes while Ana's delete runs; the second stays.
    await render(<Host ask={ask} places={["two"]} />);
    assert.equal(document.querySelectorAll("dialog").length, 0);
    await settle(work.resolve);
    assert.equal(ran, 1);
    assert.deepEqual(answers.sort(), ["Ana true", "Bo false"]);
  }));

test("M2: a required field cleared while a part works stops the save", () =>
  page(async (render) => {
    const upload = Promise.withResolvers<void>();
    const saves: unknown[] = [];
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={(change) => void saves.push(change)}
        onClose={() => {}}
      >
        {(form) => (
          <>
            <Input {...form.text("name")} required />
            <Upload wait={upload.promise} />
          </>
        )}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana S");
    await submit();
    await typeInto(input("name"), "");
    await settle(upload.resolve);
    assert.deepEqual(saves, []);
    assert.equal(dialogs()[0].open, true);
    assert.equal(input("name").closest("fieldset")!.disabled, false);
  }));

test("M3: a part handing back the stored value writes nothing; an empty list over null is []", () => {
  assert.equal(updateOf(ANA, {}, { email: "a@example.com" }), undefined);
  assert.equal(
    updateOf(ANA, { email: { kind: "text", raw: "x@example.com" } }, { email: "a@example.com" }),
    undefined,
  );
  assert.deepEqual(updateOf({ _id: "x", tags: null }, { tags: { kind: "list", raw: [] } }, {}), {
    set: { tags: [] },
    unset: [],
    update: { $set: { tags: [] } },
  });
  assert.equal(
    updateOf({ _id: "x", tags: [] }, { tags: { kind: "list", raw: [] } }, {}),
    undefined,
  );
});

test("M4: a numeric step makes a list where there's none; dates and files are copied as they are", () => {
  assert.deepEqual(createOf({}, { "lines.0.qty": { kind: "number", raw: "2" } }, {}), {
    lines: [{ qty: 2 }],
  });
  assert.deepEqual(withValue({ lines: [{ qty: 1 }] }, "lines.0.qty", 3), { lines: [{ qty: 3 }] });
  assert.deepEqual(
    updateOf({ _id: "x" }, {
      "lines.0.qty": { kind: "number", raw: "2" },
      "lines.0.sku": { kind: "text", raw: "P1" },
    }, {})?.update,
    { $set: { lines: [{ qty: 2, sku: "P1" }] } },
  );
  const since = new Date("2026-11-25T12:00:00Z");
  const file = new Blob(["x"]);
  const values = createOf({ since, file }, {}, {});
  assert.ok(values.since instanceof Date && values.since.getTime() === since.getTime());
  assert.equal(values.file, file);
  assert.ok(same(new Date(1), new Date(1)));
  assert.ok(!same(new Date(1), new Date(2)));
  assert.ok(!same(new Blob(["a"]), new Blob(["a"])));
});

test("M5: a question asked from a question goes over it; the focus ends where the first began", () =>
  page(async (render) => {
    const answers: string[] = [];
    await render(
      <Host
        ask={(confirm) =>
          void confirm({
            title: "Delete Ana?",
            danger: true,
            onConfirm: async () => {
              if (!await confirm({ title: "Her invoices too?" })) throw new Error("Kept.");
            },
          }).then((yes) => answers.push(`Ana ${yes}`))}
      />,
    );
    const opener = document.querySelector<HTMLButtonElement>("#ask")!;
    opener.focus();
    await click(opener);
    await click(button("Delete"));
    assert.equal(dialogs().length, 2);
    await click(button("Confirm"));
    assert.deepEqual(answers, ["Ana true"]);
    assert.equal(dialogs().length, 0);
    assert.ok(document.activeElement === opener, "focus on the first opener");
  }));

// Types: what the binders take at run time, they take in TypeScript too (checked, never run).
export function binders(form: RecordForm<Customer>) {
  form.value("plan").onChange(null);
  form.value("plan").onChange(undefined);
  form.value<number>("seats").onChange(3);
  form.list("tags").onChange([]);
  form.set("tags", null);
  return (change: RecordChange<Customer>) => change.kind;
}
