/**
 * The dialogs' classes as matrices: a dialog in any container, dismissed any way, closes only
 * itself; a submit from any source runs only its own form; an edit at any moment against any
 * part keeps what the person typed last. Then a save's form stays whole and its questions
 * answerable, a confirmation answers what its operation did, and the low findings. The first
 * three tests are a review's reproductions, as it ran them.
 */
import assert from "node:assert/strict";
import { act, type ReactNode, useState } from "react";
import { test } from "../../../testing/mod.ts";
import { ConfirmDialog, type ConfirmOptions, useConfirm } from "../toolkit/confirm-dialog.tsx";
import { questions, visibleOf } from "../toolkit/confirm-state.ts";
import { Dialog } from "../toolkit/dialog.tsx";
import { Drawer } from "../toolkit/drawer.tsx";
import { Field } from "../toolkit/field.tsx";
import { Form, useFormSubmit } from "../toolkit/form.tsx";
import { Input } from "../toolkit/input.tsx";
import { RecordDialog, type RecordForm } from "../toolkit/record-dialog.tsx";
import { createOf, type Edits, updateOf, withValue } from "../toolkit/record-draft.ts";
import { dismissToast, toastState } from "../toolkit/toast-state.ts";
import { page } from "./page.ts";

type Customer = { name: string; email?: string };
const ANA = { _id: "A", name: "Ana", email: "a@example.com" };

// ---- helpers (as in dialogs-timing.tsx)

function toasts(): string[] {
  const shown = toastState().toasts;
  for (const t of shown) dismissToast(t.id);
  return shown.map((t) => `${t.tone}:${String(t.message)}`);
}
const dialogs = () => [...document.querySelectorAll("dialog")];
const input = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const button = (words: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === words)!;
const click = (element: HTMLElement) => act(async () => element.click());
const settle = (run: () => void) => act(async () => run());
function typeInto(element: HTMLInputElement, value: string) {
  return act(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(
      element,
      value,
    );
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const escape = (target: HTMLDialogElement) =>
  act(() => {
    const cancel = new window.Event("cancel", { cancelable: true });
    target.dispatchEvent(cancel);
    if (!cancel.defaultPrevented) target.close();
  });
const backdrop = (target: HTMLDialogElement) =>
  act(() => {
    target.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
    target.click();
  });
const closeQuietly = (target: HTMLDialogElement) => act(() => target.removeAttribute("open"));
const closeEvent = (target: HTMLDialogElement) =>
  act(() => void target.dispatchEvent(new window.Event("close")));
/** The dialog whose own title is `title` (an outer dialog holds its inner one's title too). */
const titled = (title: string) =>
  dialogs().find((d) => d.querySelector("h2")?.textContent === title)!;

const fields = (form: RecordForm<Customer>, more?: ReactNode) => (
  <>
    <Field label="Name" error={form.error("name")}>
      {(c) => <Input {...c} {...form.text("name")} />}
    </Field>
    {more}
  </>
);

/** React says a form in a form isn't HTML: nesting them is these tests' point. */
async function quietNesting(run: () => Promise<void>) {
  const errors = console.error;
  console.error = (...args: unknown[]) => {
    if (!String(args[0]).includes("cannot be a descendant of")) errors(...args);
  };
  try {
    await run();
  } finally {
    console.error = errors;
  }
}

// ---- the review's reproductions

function EditOrder() {
  const [dialog, confirm] = useConfirm();
  const [note, setNote] = useState("");
  return (
    <>
      <Input name="note" value={note} onChange={(e) => setNote(e.target.value)} />
      <button
        type="button"
        id="remove"
        onClick={() =>
          void confirm({ title: "Remove the line?", danger: true, onConfirm: () => {} })}
      >
        Remove line
      </button>
      {dialog}
    </>
  );
}

test("P2b: a question in a bottom sheet, dismissed, keeps the sheet and its note", () =>
  page(async (render) => {
    const said: string[] = [];
    function Screen() {
      const [editing, setEditing] = useState(true);
      return editing
        ? (
          <Drawer
            open
            side="bottom"
            title="Order 12"
            onClose={() => {
              said.push("drawer closed");
              setEditing(false);
            }}
          >
            <EditOrder />
          </Drawer>
        )
        : <p id="list">Orders</p>;
    }
    await render(<Screen />);
    await typeInto(input("note"), "Deliver after 6pm, ring twice");
    await click(document.querySelector<HTMLButtonElement>("#remove")!);
    const question = dialogs().find((d) => d.getAttribute("role") === "alertdialog")!;
    await escape(question);
    assert.deepEqual(said, []);
    assert.equal(input("note").value, "Deliver after 6pm, ring twice");
  }));

test("P3: a plain Form in a record's fields doesn't save or close the record", () =>
  page((render) =>
    quietNesting(async () => {
      const said: string[] = [];
      await render(
        <RecordDialog<Customer>
          title="Ana"
          record={ANA}
          onSave={(c) =>
            void said.push(`record saved ${JSON.stringify(c.kind === "update" && c.set)}`)}
          onClose={() => said.push("record closed")}
        >
          {(form) =>
            fields(
              form,
              <Dialog open title="New tag" onClose={() => said.push("tag dialog closed")}>
                <Form onSubmit={() => void said.push("tag added")}>
                  <Input name="tag" defaultValue="vip" />
                  <button type="submit">Add tag</button>
                </Form>
              </Dialog>,
            )}
        </RecordDialog>,
      );
      await typeInto(input("name"), "Ana half-typed");
      await act(async () => input("tag").closest("form")!.requestSubmit());
      assert.deepEqual(said, ["tag added"]);
    })
  ));

function Normalize({ wait }: { wait: Promise<void> }) {
  useFormSubmit(async (form) => {
    const name = (form.elements.namedItem("name") as HTMLInputElement).value;
    await wait;
    return { name: name.trim() };
  });
  return null;
}

test("P6: a correction typed while a part works wins over what the part hands up", () =>
  page(async (render) => {
    const check = Promise.withResolvers<void>();
    const saves: unknown[] = [];
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        toast="Saved."
        onSave={(c) => void saves.push(c.kind === "update" && c.set)}
        onClose={() => {}}
      >
        {(form) => fields(form, <Normalize wait={check.promise} />)}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana Sliva ");
    await act(async () => document.querySelector("form")!.requestSubmit());
    await typeInto(input("name"), "Ana Silva");
    await settle(check.resolve);
    assert.deepEqual(saves, [{ name: "Ana Silva" }]);
    toasts();
  }));

// ---- H1's class: nesting × container × dismissal

const INNERS = ["ConfirmDialog", "useConfirm", "RecordDialog"] as const;
const OUTERS = [
  "Dialog",
  "Drawer left",
  "Drawer right",
  "Drawer bottom",
  "RecordDialog",
  "ConfirmDialog",
] as const;
const DISMISSALS = {
  "Escape": (d: HTMLDialogElement) => escape(d),
  "×": (d: HTMLDialogElement) => click(d.querySelector<HTMLButtonElement>('[aria-label="Close"]')!),
  "the backdrop": (d: HTMLDialogElement) => backdrop(d),
  "close()": (d: HTMLDialogElement) => act(() => d.close()),
};

/** What the outer one holds: a note being typed, and the inner dialog. */
function Note() {
  const [note, setNote] = useState("");
  return <Input name="note" value={note} onChange={(e) => setNote(e.target.value)} />;
}
function Asks({ said }: { said: string[] }) {
  const [dialog, confirm] = useConfirm();
  return (
    <>
      <button
        type="button"
        id="ask"
        onClick={() =>
          void confirm({ title: "Inner", onConfirm: () => {} }).then((yes) =>
            said.push(`inner answered ${yes}`)
          )}
      >
        Ask
      </button>
      {dialog}
    </>
  );
}
function Inner({ kind, said }: { kind: typeof INNERS[number]; said: string[] }) {
  if (kind === "useConfirm") return <Asks said={said} />;
  if (kind === "ConfirmDialog") {
    return (
      <ConfirmDialog
        title="Inner"
        onConfirm={() => {}}
        onClose={() => said.push("inner closed")}
      />
    );
  }
  return (
    <RecordDialog<Customer>
      title="Inner"
      onSave={() => {}}
      onClose={() => said.push("inner closed")}
    >
      {(form) => <Input {...form.text("name")} />}
    </RecordDialog>
  );
}
function Outer({ kind, said, children }: {
  kind: typeof OUTERS[number];
  said: string[];
  children: ReactNode;
}) {
  const close = () => said.push("outer closed");
  const inside = (
    <>
      <Note />
      {children}
    </>
  );
  if (kind === "Dialog") return <Dialog open title="Outer" onClose={close}>{inside}</Dialog>;
  if (kind.startsWith("Drawer")) {
    const side = kind.split(" ")[1] as "left" | "right" | "bottom";
    return <Drawer open side={side} title="Outer" onClose={close}>{inside}</Drawer>;
  }
  if (kind === "ConfirmDialog") {
    return (
      <ConfirmDialog title="Outer" onConfirm={() => {}} onClose={close}>{inside}</ConfirmDialog>
    );
  }
  return (
    <RecordDialog<Customer> title="Outer" record={ANA} onSave={() => {}} onClose={close}>
      {() => inside}
    </RecordDialog>
  );
}

test("H1 class: a dialog inside any container, dismissed any way, closes only itself", () =>
  page((render) =>
    quietNesting(async () => {
      for (const inner of INNERS) {
        for (const outer of OUTERS) {
          for (const [how, dismiss] of Object.entries(DISMISSALS)) {
            const said: string[] = [];
            const name = `${inner} in ${outer}, ${how}`;
            await render(
              <Outer key={name} kind={outer} said={said}>
                <Inner kind={inner} said={said} />
              </Outer>,
            );
            await typeInto(input("note"), "Typed");
            if (inner === "useConfirm") {
              await click(document.querySelector<HTMLButtonElement>("#ask")!);
            }
            await dismiss(titled("Inner"));
            assert.deepEqual(
              said,
              [inner === "useConfirm" ? "inner answered false" : "inner closed"],
              name,
            );
            assert.equal(titled("Outer").open, true, name);
            assert.equal(input("note").value, "Typed", name);
          }
        }
      }
    })
  ));

// ---- H2's class: submit source × nesting

test("H2 class: a submit from any source runs only its own form", () =>
  page((render) =>
    quietNesting(async () => {
      const cases: [string, string[]][] = [
        ["the record's own form", ["record saved"]],
        ["a Form in the fields", ["form submitted"]],
        ["a Form in a Dialog in the fields", ["form submitted"]],
        ["a RecordDialog in the fields", ["inner saved", "inner closed"]],
        ["a Form around the record dialog", ["outer form submitted"]],
        ["the record, in a Form", ["record saved"]],
      ];
      for (const [source, expected] of cases) {
        const said: string[] = [];
        const plain = (
          <Form onSubmit={() => void said.push("form submitted")}>
            <Input name="tag" defaultValue="vip" />
          </Form>
        );
        const nested = source === "a Form in the fields"
          ? plain
          : source === "a Form in a Dialog in the fields"
          ? <Dialog open title="Tag" onClose={() => said.push("tag closed")}>{plain}</Dialog>
          : source === "a RecordDialog in the fields"
          ? (
            <RecordDialog<Customer>
              title="Inner"
              onSave={() => void said.push("inner saved")}
              onClose={() => said.push("inner closed")}
            >
              {(form) => <Input {...form.text("tag")} />}
            </RecordDialog>
          )
          : null;
        const record = (
          <RecordDialog<Customer>
            key={source}
            title="Ana"
            record={ANA}
            onSave={() => void said.push("record saved")}
            onClose={() => said.push("record closed")}
          >
            {(form) => fields(form, nested)}
          </RecordDialog>
        );
        const around = source.endsWith("the record dialog") || source.endsWith("in a Form");
        await render(
          around
            ? (
              <Form key={source} onSubmit={() => void said.push("outer form submitted")}>
                <Input name="outer" defaultValue="x" />
                {record}
              </Form>
            )
            : record,
        );
        await typeInto(input("name"), "Ana S");
        if (source === "a RecordDialog in the fields") await typeInto(input("tag"), "Cy");
        const form = source === "the record's own form" || source === "the record, in a Form"
          ? titled("Ana").querySelector("form")!
          : source === "a Form around the record dialog"
          ? input("outer").closest("form")!
          : input("tag").closest("form")!;
        await act(async () => form.requestSubmit());
        // Saved, the record dialog closes: that's its own.
        const own = source === "the record's own form" || source === "the record, in a Form";
        assert.deepEqual(said, own ? [...expected, "record closed"] : expected, source);
        toasts();
      }
    })
  ));

// ---- H3's class: edit timing × part behaviour

test("H3 class: what's typed after the submit wins over a part's value for that field", () => {
  const stored = { _id: "A", name: "Ana", email: "a@example.com" };
  const typed = (raw: string) => ({ kind: "text" as const, raw });
  const parts = {
    "hands up nothing": {},
    "normalizes the name it read": { name: "Ana S" },
    "hands back the stored name": { name: "Ana" },
    "hands up another field": { email: "b@example.com" },
  };
  // When the person typed, and the edits as they are when the save starts.
  const timings: Record<string, { edits: Edits; after: string[] }> = {
    "never": { edits: {}, after: [] },
    "before the submit": { edits: { name: typed("Ana S ") }, after: [] },
    "while the part works": { edits: { name: typed("Ana Silva") }, after: ["name"] },
    "before, then while it works": { edits: { name: typed("Ana Silva") }, after: ["name"] },
    "while it works, back to the stored name": { edits: { name: typed("Ana") }, after: ["name"] },
  };
  const expected: Record<string, Record<string, unknown> | undefined> = {
    "never | hands up nothing": undefined,
    "never | normalizes the name it read": { name: "Ana S" },
    "never | hands back the stored name": undefined,
    "never | hands up another field": { email: "b@example.com" },
    "before the submit | hands up nothing": { name: "Ana S " },
    "before the submit | normalizes the name it read": { name: "Ana S" },
    "before the submit | hands back the stored name": undefined,
    "before the submit | hands up another field": { name: "Ana S ", email: "b@example.com" },
  };
  for (const [when, { edits, after }] of Object.entries(timings)) {
    for (const [what, handed] of Object.entries(parts)) {
      const name = `${when} | ${what}`;
      const late = after.includes("name");
      const want = name in expected ? expected[name] : late
        ? {
          ...(edits.name.raw === "Ana" ? {} : { name: edits.name.raw }),
          ...(what === "hands up another field" ? { email: "b@example.com" } : {}),
        }
        : undefined;
      const got = updateOf(stored, edits, handed, new Set(after))?.set;
      assert.deepEqual(got, want && Object.keys(want).length ? want : undefined, name);
      // A new record keeps the same rule.
      const made = createOf({ name: "Ana" }, edits, handed, new Set(after));
      if (late) assert.equal(made.name, edits.name.raw, `create: ${name}`);
    }
  }
});

test("H3 class: a part handing up a field that holds a later edit keeps the edit inside it", () => {
  const stored = { _id: "A", address: { city: "Recife", street: "Rua A" } };
  const edits: Edits = { "address.city": { kind: "text", raw: "Olinda" } };
  const handed = { address: { city: "RECIFE", street: "Rua B" } };
  assert.deepEqual(updateOf(stored, edits, handed, new Set(["address.city"]))?.set, {
    address: { city: "Olinda", street: "Rua B" },
  });
  const inner = { "address.city": "RECIFE" };
  assert.equal(
    updateOf(stored, edits, inner, new Set(["address.city"]))?.set["address.city"],
    "Olinda",
  );
});

// ---- M2 and M3: a save's form stays whole, and its questions answerable

test("M2, M3: while a save runs, no control is disabled or inert, FormData holds every field, and a question in the fields can be answered", () =>
  page(async (render) => {
    const seen: string[] = [];
    let asked: ((q: ConfirmOptions) => Promise<boolean>) | undefined;
    function Ask() {
      const [dialog, confirm] = useConfirm();
      asked = confirm;
      return <>{dialog}</>;
    }
    const blocked = (element: Element) =>
      (element as HTMLInputElement).disabled ||
      !!element.closest("fieldset[disabled], [inert]");
    await render(
      <RecordDialog<Customer>
        title="Ana"
        record={ANA}
        onSave={async (_change, form) => {
          await Promise.resolve();
          const controls = [...form.elements].filter((e) => (e as HTMLInputElement).name);
          seen.push(
            `blocked: ${controls.filter(blocked).map((e) => (e as HTMLInputElement).name)}`,
          );
          seen.push(`form data: ${[...new window.FormData(form).keys()].join(",")}`);
          seen.push(`answered ${await asked!({ title: "Change the price on 3 orders?" })}`);
        }}
        onClose={() => seen.push("closed")}
      >
        {(form) => (
          <>
            <Input {...form.text("name")} />
            <Input {...form.text("email")} />
            <Ask />
          </>
        )}
      </RecordDialog>,
    );
    await typeInto(input("name"), "Ana S");
    await act(async () => document.querySelector("form")!.requestSubmit());
    // Read-only while it saves: typing changes nothing, but nothing is disabled or inert.
    assert.equal(input("name").readOnly, true);
    await typeInto(input("name"), "Ana T");
    assert.equal(input("name").value, "Ana S");
    const question = dialogs().find((d) => d.getAttribute("role") === "alertdialog")!;
    const confirmButton = button("Confirm", question);
    assert.equal(blocked(confirmButton), false);
    await click(confirmButton);
    assert.deepEqual(seen, [
      "blocked: ",
      "form data: name,email",
      "answered true",
      "closed",
    ]);
  }));

// ---- M1's class: what a confirmation answers when the browser closed it meanwhile

test("M1 class: the answer is the operation's outcome, whichever comes first", () =>
  page(async (render) => {
    for (const api of ["useConfirm", "ConfirmDialog"]) {
      for (const outcome of ["done", "failed"]) {
        for (
          const order of ["close event, then the outcome", "the outcome, then its close event"]
        ) {
          toasts();
          const name = `${api}, ${outcome}, ${order}`;
          const work = Promise.withResolvers<void>();
          const said: string[] = [];
          const question: ConfirmOptions = {
            title: "Delete Ana?",
            toast: "Deleted.",
            onConfirm: () => work.promise,
          };
          if (api === "useConfirm") {
            await render(
              <Asker
                key={name}
                ask={(confirm) =>
                  void confirm(question).then((yes) => said.push(`answered ${yes}`))}
              />,
            );
            await click(document.querySelector<HTMLButtonElement>("#ask")!);
          } else {
            await render(
              <ConfirmDialog
                key={name}
                {...question}
                onConfirm={() => work.promise}
                onClose={() => said.push("closed")}
              />,
            );
          }
          await click(button("Confirm"));
          const [asking] = dialogs();
          await closeQuietly(asking);
          if (order.startsWith("close event")) await closeEvent(asking);
          await settle(() => outcome === "done" ? work.resolve() : work.reject(new Error("Kept.")));
          if (!order.startsWith("close event")) await closeEvent(asking);
          assert.deepEqual(
            said,
            api === "useConfirm" ? [`answered ${outcome === "done"}`] : ["closed"],
            name,
          );
          assert.deepEqual(
            toasts(),
            [outcome === "done" ? "success:Deleted." : "destructive:Kept."],
            name,
          );
        }
      }
    }
  }));

function Asker({ ask }: { ask: (confirm: (q: ConfirmOptions) => Promise<boolean>) => void }) {
  const [dialog, confirm] = useConfirm();
  return (
    <>
      <button type="button" id="ask" onClick={() => ask(confirm)}>Ask</button>
      {dialog}
    </>
  );
}

// ---- Low

test("low: a ConfirmDialog given a new key while open gives the focus back to the first opener", () =>
  page(async (render) => {
    function Screen({ subject }: { subject?: string }) {
      return (
        <>
          <button type="button" id="opener">Delete</button>
          {subject
            ? (
              <ConfirmDialog
                key={subject}
                title={`Delete ${subject}?`}
                onConfirm={() => {}}
                onClose={() => {}}
              />
            )
            : null}
        </>
      );
    }
    await render(<Screen />);
    const opener = document.querySelector<HTMLButtonElement>("#opener")!;
    opener.focus();
    await render(<Screen subject="Ana" />);
    await render(<Screen subject="Bo" />);
    await render(<Screen />);
    assert.ok(document.activeElement === opener, "focus on the opener");
  }));

test("low: a number step over nothing is refused, not guessed; over a list or an object it goes in", () => {
  const lines = { "lines.0.qty": { kind: "number" as const, raw: "2" } };
  const hours = { "hours.1": { kind: "text" as const, raw: "9-18" } };
  assert.throws(() => createOf({}, lines, {}), /lines.*a value/);
  assert.throws(() => updateOf({ _id: "x" }, hours, {}), /hours.*a value/);
  assert.deepEqual(createOf({ lines: [] }, lines, {}), { lines: [{ qty: 2 }] });
  assert.deepEqual(createOf({ hours: {} }, hours, {}), { hours: { 1: "9-18" } });
  assert.deepEqual(updateOf({ _id: "x", hours: {} }, hours, {})?.update, {
    $set: { "hours.1": "9-18" },
  });
  // What the form shows guesses neither: the edit is in `get`, not drawn into a shape.
  assert.deepEqual(withValue({}, "hours.1", "9-18"), {});
});

test("low: a question whose operation runs stays on the screen when one under it fails", () => {
  const asked = questions<string>();
  asked.host({});
  void asked.ask("A");
  void asked.ask("B");
  void asked.ask("C");
  const [a, b] = asked.queue();
  asked.running(a.id, true);
  asked.running(b.id, true);
  // A failed: it's waiting again, with its words; B still runs.
  asked.running(a.id, false);
  assert.deepEqual(visibleOf(asked.queue()).map((q) => q.options), ["A", "B"]);
});

test("H1 class, the outer side: an isolated Dialog or Drawer stays open when an app's own dialog inside it closes; unset, as in rc.64", () =>
  page(async (render) => {
    for (const outer of ["Dialog", "Drawer"]) {
      for (const isolated of [true, false]) {
        const said: string[] = [];
        const name = `${outer}${isolated ? " isolated" : ""}`;
        const inner = (
          <Dialog open title="Inner" onClose={() => said.push("inner closed")}>
            <p>Plain</p>
          </Dialog>
        );
        await render(
          outer === "Dialog"
            ? (
              <Dialog
                key={name}
                open
                title="Outer"
                isolated={isolated}
                onClose={() => said.push("outer closed")}
              >
                {inner}
              </Dialog>
            )
            : (
              <Drawer
                key={name}
                open
                title="Outer"
                isolated={isolated}
                onClose={() => said.push("outer closed")}
              >
                {inner}
              </Drawer>
            ),
        );
        await act(() => titled("Inner").close());
        assert.deepEqual(
          said,
          isolated ? ["inner closed"] : ["inner closed", "outer closed"],
          name,
        );
      }
    }
  }));
