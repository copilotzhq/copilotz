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
import { ConfirmDialog, useConfirm } from "../toolkit/confirm-dialog.tsx";
import { Dialog } from "../toolkit/dialog.tsx";
import { Drawer } from "../toolkit/drawer.tsx";
import { Input } from "../toolkit/input.tsx";
import { RecordDialog } from "../toolkit/record-dialog.tsx";
import { page } from "./page.ts";

type Customer = { name: string; email?: string };
const ANA = { _id: "A", name: "Ana", email: "a@example.com" };

// ---- helpers (as in dialogs-timing.tsx)

const dialogs = () => [...document.querySelectorAll("dialog")];
const input = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const click = (element: HTMLElement) => act(async () => element.click());
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
/** The dialog whose own title is `title` (an outer dialog holds its inner one's title too). */
const titled = (title: string) =>
  dialogs().find((d) => d.querySelector("h2")?.textContent === title)!;

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

// ---- H3's class: edit timing × part behaviour

// ---- M2 and M3: a save's form stays whole, and its questions answerable

test("H1 class, the outer side: an isolated Dialog stays open when an app's own dialog inside it closes; unset, as in rc.64", () =>
  page(async (render) => {
    for (const isolated of [true, false]) {
      {
        const said: string[] = [];
        const name = isolated ? "isolated" : "as in rc.64";
        const inner = (
          <Dialog open title="Inner" onClose={() => said.push("inner closed")}>
            <p>Plain</p>
          </Dialog>
        );
        await render(
          <Dialog
            key={name}
            open
            title="Outer"
            isolated={isolated}
            onClose={() => said.push("outer closed")}
          >
            {inner}
          </Dialog>,
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
