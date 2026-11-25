/**
 * rc.64's form and dialog pieces, pinned before rc.65 builds on them: `Form`, `Field`,
 * `PartSubmit`, `useFormSubmit`, `Dialog` and `useModal` say and do what they did. `Form` and
 * `Field` stay byte-identical; `Dialog` and `useModal` may only gain options, and with them
 * unset they draw the same markup and call back the same way.
 */
import assert from "node:assert/strict";
import { act, type ComponentProps, type ReactNode, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { Dialog } from "../toolkit/dialog.tsx";
import { type Control, Field } from "../toolkit/field.tsx";
import { Form, type PartSubmit, useFormState, useFormSubmit } from "../toolkit/form.tsx";
import { Input } from "../toolkit/input.tsx";
import { useModal } from "../toolkit/modal.ts";
import { page } from "./page.ts";

/** What a piece draws, without its stylesheets. */
const html = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");

const CLOSE = '<span class="copilotz-tooltip-for"><button type="button" ' +
  'class="copilotz-icon-button copilotz-icon-button-sm" aria-label="Close"><svg class="copilotz-icon" ' +
  'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18">' +
  "</path></svg></button></span>";

// Drawn by rc.64 (ddf3c6ec).
const RC64 = {
  dialogPlain: '<dialog class="copilotz-dialog" aria-labelledby="_R_0_-title" closedby="any">' +
    '<div class="copilotz-dialog-box"><header class="copilotz-dialog-head"><div>' +
    '<h2 id="_R_0_-title" class="copilotz-dialog-title">Edit</h2></div>' + CLOSE +
    '</header><div class="copilotz-dialog-body">x</div></div></dialog>',
  dialogAll:
    '<dialog class="copilotz-dialog copilotz-dialog-lg copilotz-dialog-top" tabindex="-1" ' +
    'aria-labelledby="_R_0_-title" aria-describedby="_R_0_-description" closedby="any">' +
    '<div class="copilotz-dialog-box mine"><header class="copilotz-dialog-head"><div>' +
    '<h2 id="_R_0_-title" class="copilotz-dialog-title">Edit</h2>' +
    '<p id="_R_0_-description" class="copilotz-dialog-description">One record</p></div>' + CLOSE +
    '</header><div class="copilotz-dialog-body">x</div>' +
    '<footer class="copilotz-dialog-foot"><button>Save</button></footer></div></dialog>',
  dialogBare: '<dialog class="copilotz-dialog copilotz-dialog-auto" aria-label="A picture" ' +
    'closedby="any"><div class="copilotz-dialog-box">x</div></dialog>',
  dialogSm: '<dialog class="copilotz-dialog copilotz-dialog-sm" aria-labelledby="_R_0_-title" ' +
    'closedby="any"><div class="copilotz-dialog-box"><header class="copilotz-dialog-head"><div>' +
    '<h2 id="_R_0_-title" class="copilotz-dialog-title">Ask</h2></div>' + CLOSE +
    '</header><div class="copilotz-dialog-body">x</div></div></dialog>',
  fieldFn: '<div class="copilotz-field"><label class="copilotz-field-label" for="_R_0_">Name' +
    '<span class="copilotz-field-mark" aria-hidden="true">*</span>' +
    '<span class="copilotz-sr">, required</span></label><span class="copilotz-input">' +
    '<input id="_R_0_" aria-describedby="_R_0_-note" name="name"/></span>' +
    '<p id="_R_0_-note" class="copilotz-field-note">As on the invoice</p></div>',
  fieldError: '<div class="copilotz-field copilotz-field-row" data-invalid="true" ' +
    'style="--field-row-label-width:25%;--field-row-control-width:50%">' +
    '<label class="copilotz-field-label" for="_R_0_">Email</label>' +
    '<div class="copilotz-field-control"><span class="copilotz-input" data-invalid="true">' +
    '<input id="_R_0_" aria-describedby="_R_0_-note" aria-invalid="true"/></span>' +
    '<p id="_R_0_-note" class="copilotz-field-note copilotz-field-error">Not complete</p></div></div>',
  fieldFor: '<div class="copilotz-field" data-invalid="true">' +
    '<label class="copilotz-field-label" for="phone">Phone</label>' +
    '<span class="copilotz-input"><input id="phone"/></span>' +
    '<p id="_R_0_-note" class="copilotz-field-note copilotz-field-error">Bad</p></div>',
};

// The contracts' types, as rc.63 and rc.64 callers compile against them.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Check<T extends true> = T;
export type Contracts = [
  Check<Same<Parameters<PartSubmit>, [form: HTMLFormElement]>>,
  Check<
    Same<
      Parameters<NonNullable<ComponentProps<typeof Form>["onSubmit"]>>,
      [values: Record<string, unknown>, form: HTMLFormElement]
    >
  >,
  Check<Same<Control, { id: string; "aria-describedby"?: string; "aria-invalid"?: true }>>,
  Check<
    Same<
      keyof ComponentProps<typeof Field>,
      | "label"
      | "hint"
      | "error"
      | "required"
      | "htmlFor"
      | "layout"
      | "labelWidth"
      | "controlWidth"
      | "className"
      | "children"
    >
  >,
  Check<Same<ReturnType<typeof useFormSubmit>, { inForm: boolean; submitting: boolean }>>,
];

test("rc.64 parity: Dialog draws the same markup", () => {
  assert.equal(html(<Dialog open onClose={() => {}} title="Edit">x</Dialog>), RC64.dialogPlain);
  assert.equal(
    html(
      <Dialog
        open
        onClose={() => {}}
        title="Edit"
        description="One record"
        size="lg"
        placement="top"
        focus="dialog"
        footer={<button>Save</button>}
        className="mine"
      >
        x
      </Dialog>,
    ),
    RC64.dialogAll,
  );
  assert.equal(
    html(<Dialog open={false} onClose={() => {}} label="A picture" size="auto" bare>x</Dialog>),
    RC64.dialogBare,
  );
  assert.equal(
    html(<Dialog open onClose={() => {}} title="Ask" size="sm">x</Dialog>),
    RC64.dialogSm,
  );
});

test("rc.64 parity: Field draws the same markup", () => {
  assert.equal(
    html(
      <Field label="Name" hint="As on the invoice" required>
        {(c) => <Input {...c} name="name" />}
      </Field>,
    ),
    RC64.fieldFn,
  );
  assert.equal(
    html(
      <Field label="Email" error="Not complete" layout="row" labelWidth="25%" controlWidth="50%">
        {(c) => <Input {...c} />}
      </Field>,
    ),
    RC64.fieldError,
  );
  assert.equal(
    html(
      <Field label="Phone" htmlFor="phone" error="Bad">
        <Input id="phone" />
      </Field>,
    ),
    RC64.fieldFor,
  );
});

test("rc.64 parity: useModal's handlers, and how a Dialog closes", () =>
  page(async (render) => {
    let keys: string[] = [];
    function Modal() {
      const { events } = useModal(true, () => {});
      keys = Object.keys(events);
      return null;
    }
    await render(<Modal />);
    assert.deepEqual(keys, ["onClose", "onPointerDown", "onClick"]);

    const closed: string[] = [];
    const show = (n: number) =>
      render(
        <Dialog key={n} open onClose={() => closed.push(`closed ${n}`)} title="Edit">
          <input />
        </Dialog>,
      );
    await show(1);
    const dialog = () => document.querySelector("dialog")!;
    assert.equal(dialog().open, true);
    // Escape asks with a cancel event, which the dialog lets go.
    const cancel = new window.Event("cancel", { cancelable: true });
    dialog().dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, false);
    // A press that starts and ends on the backdrop closes it.
    await act(() => {
      dialog().dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true }));
      dialog().click();
    });
    assert.deepEqual(closed, ["closed 1"]);
    // Its × closes it too.
    await show(2);
    await act(() => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    assert.deepEqual(closed, ["closed 1", "closed 2"]);
  }));

function Upload({ wait, name = "A.pdf" }: { wait: Promise<void>; name?: string }) {
  useFormSubmit(async () => {
    await wait;
    return { file: name };
  });
  return null;
}

const submit = () => act(async () => document.querySelector("form")!.requestSubmit());

test("rc.64 parity: an unmounted Form still runs its final save once its part is done", () =>
  page(async (render) => {
    const saved: unknown[] = [];
    const upload = Promise.withResolvers<void>();
    await render(
      <Form onSubmit={(values, form) => saved.push([values, form.tagName])}>
        <Upload wait={upload.promise} />
      </Form>,
    );
    await submit();
    await render(null);
    await act(async () => upload.resolve());
    assert.deepEqual(saved, [[{ file: "A.pdf" }, "FORM"]]);
  }));

test("rc.64 parity: Form's parts in order; one submit at a time; a stop, and a failure at its top", () =>
  page(async (render) => {
    const ran: string[] = [];
    const upload = Promise.withResolvers<void>();
    let answer: false | { b: number } = { b: 2 };
    let fail = false;
    let busy: boolean[] = [];
    function First() {
      useFormSubmit(async () => {
        ran.push("first");
        await upload.promise;
        return { a: 1 };
      });
      return null;
    }
    function Second() {
      useFormSubmit(() => {
        ran.push("second");
        return answer;
      });
      return null;
    }
    function Busy() {
      busy.push(useFormState().submitting);
      return null;
    }
    function Outside() {
      const state = useFormSubmit(() => undefined);
      ran.push(`outside ${state.inForm} ${state.submitting}`);
      return null;
    }
    await render(
      <>
        <Outside />
        <Form
          onSubmit={(values) => {
            ran.push(`own ${JSON.stringify(values)}`);
            if (fail) throw new Error("The price is missing.");
          }}
        >
          <First />
          <Second />
          <Busy />
        </Form>
      </>,
    );
    busy = [];
    await submit();
    await submit(); // ignored: the first is still saving
    assert.equal(document.querySelector("form")!.getAttribute("aria-busy"), "true");
    await act(async () => upload.resolve());
    assert.deepEqual(ran, ["outside false false", "first", "second", 'own {"a":1,"b":2}']);
    assert.equal(busy[0], true);
    assert.equal(busy.at(-1), false);

    ran.length = 0;
    answer = false;
    await submit();
    assert.deepEqual(ran, ["first", "second"]);
    assert.equal(document.querySelector('[role="alert"]'), null);

    ran.length = 0;
    answer = { b: 3 };
    fail = true;
    await submit();
    assert.equal(document.querySelector('[role="alert"]')!.textContent, "The price is missing.");
    fail = false;
    await submit();
    assert.equal(document.querySelector('[role="alert"]'), null);
  }));

test("rc.64 parity: a Form's onSubmit is the latest when the parts are done", () =>
  page(async (render) => {
    const saved: string[] = [];
    const upload = Promise.withResolvers<void>();
    function Editor() {
      const [name, setName] = useState("first");
      return (
        <Form onSubmit={() => saved.push(name)}>
          <Upload wait={upload.promise} />
          <button type="button" onClick={() => setName("second")}>Rename</button>
        </Form>
      );
    }
    await render(<Editor />);
    await submit();
    await act(() => document.querySelector<HTMLButtonElement>("form button")!.click());
    await act(async () => upload.resolve());
    assert.deepEqual(saved, ["second"]);
  }));
