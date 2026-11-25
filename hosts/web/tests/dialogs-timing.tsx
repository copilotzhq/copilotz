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
import { ConfirmDialog } from "../toolkit/confirm-dialog.tsx";
import { Field } from "../toolkit/field.tsx";
import { useFormSubmit } from "../toolkit/form.tsx";
import { Input } from "../toolkit/input.tsx";
import { type RecordChange, RecordDialog, type RecordForm } from "../toolkit/record-dialog.tsx";
import { updateOf } from "../toolkit/record-draft.ts";
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
      toasts();
    }
  }));

// ---- 3. Typing while the save runs

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

// ---- Medium and low

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

// Round 2: a number step over nothing isn't guessed a list any more (a map of numbers looks the
// same); it's refused, and goes into a list or an object that's there (dialogs-matrix.tsx).
export function binders(form: RecordForm<Customer>) {
  form.value("plan").onChange(null);
  form.value("plan").onChange(undefined);
  form.value<number>("seats").onChange(3);
  form.list("tags").onChange([]);
  form.set("tags", null);
  return (change: RecordChange<Customer>) => change.kind;
}
