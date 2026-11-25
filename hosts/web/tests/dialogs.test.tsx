/**
 * The dialogs as the page draws them (React, rendered to markup): a confirm dialog is an
 * `alertdialog` named by its question and described by its message, its words the toolkit's,
 * focus on the confirm button (on Cancel for a delete); busy, it keeps itself open and its
 * buttons wait; failed, it says why and stays. A record's dialog draws its fields from data
 * (labels, marks, each kind's control holding its value), or as children, with Cancel and a Save
 * that submits its form. A `Field` with a `name` gives its control that name.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { test } from "../../../testing/mod.ts";
import { ConfirmDialog, ConfirmView } from "../toolkit/confirm-dialog.tsx";
import { Dialog } from "../toolkit/dialog.tsx";
import { EntityDialog } from "../toolkit/entity-dialog.tsx";
import { Field } from "../toolkit/field.tsx";
import { Form } from "../toolkit/form.tsx";
import { Input } from "../toolkit/input.tsx";

/** What a piece draws, without its stylesheets. */
const html = (node: ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<style[\s\S]*?<\/style>/g, "");
const count = (markup: string, pattern: RegExp) => markup.match(pattern)?.length ?? 0;
/** A button, by its words. */
const button = (markup: string, words: string) =>
  new RegExp(`<button[^>]*>(?:(?!</button>).)*${words}</button>`).exec(markup)?.[0] ?? "";
/** A control's tag, by its name. */
const control = (markup: string, name: string) =>
  new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`).exec(markup)?.[0] ?? "";
/** Whether a tag has each of these attributes, in any order. */
const has = (tag: string, ...attributes: string[]) => {
  for (const attribute of attributes) assertStringIncludes(tag, attribute);
};
/** The header's close button. */
const closer = (markup: string) => /<button[^>]*aria-label="Close"[^>]*>/.exec(markup)?.[0] ?? "";

const nothing = () => {};

test("a confirm: an alertdialog named by its question, described by its message", () => {
  const out = html(
    <ConfirmDialog
      title="Archive the order?"
      message="It leaves the open orders."
      onConfirm={nothing}
      onClose={nothing}
    />,
  );
  assertStringIncludes(out, 'role="alertdialog"');
  assertStringIncludes(out, ">Archive the order?</h2>");
  const described = /aria-describedby="([^"]+)"/.exec(out)?.[1];
  assert(described, "described by its message");
  assertStringIncludes(
    out,
    `<p id="${described}" class="copilotz-text">It leaves the open orders.</p>`,
  );
  // The toolkit's words; focus on the confirm button, so Enter confirms.
  assertStringIncludes(button(out, "Cancel"), "copilotz-button-outline");
  assertStringIncludes(button(out, "Confirm"), "copilotz-button-primary");
  assertStringIncludes(button(out, "Confirm"), 'data-autofocus=""');
  assert(!button(out, "Cancel").includes("data-autofocus"));
});

test("a delete: a destructive button, its own words, and Cancel focused so Enter never deletes", () => {
  const out = html(
    <ConfirmDialog
      title="Delete Ana Silva?"
      danger
      confirmLabel="Delete customer"
      cancelLabel="Keep"
      onConfirm={nothing}
      onClose={nothing}
    >
      <ul>
        <li>3 visits</li>
      </ul>
    </ConfirmDialog>,
  );
  assertStringIncludes(button(out, "Delete customer"), "copilotz-button-destructive");
  assert(!button(out, "Delete customer").includes("data-autofocus"));
  assertStringIncludes(button(out, "Keep"), 'data-autofocus=""');
  assertStringIncludes(out, "<li>3 visits</li>");
  // No message: described by nothing.
  assert(!out.includes("aria-describedby"));
  // A delete's button says so by default.
  assertStringIncludes(
    html(<ConfirmDialog title="Delete it?" danger onConfirm={nothing} onClose={nothing} />),
    ">Delete</button>",
  );
});

test("busy: the dialog stays open and says so; its buttons wait, the confirm one spinning", () => {
  const out = html(
    <ConfirmView
      id="c"
      open
      title="Delete Ana Silva?"
      danger
      busy
      onConfirm={nothing}
      onCancel={nothing}
    />,
  );
  assertStringIncludes(out, 'aria-busy="true" closedby="any"');
  const confirmIt = button(out, "Delete");
  assertStringIncludes(confirmIt, 'disabled=""');
  assertStringIncludes(confirmIt, 'aria-busy="true"');
  assertStringIncludes(confirmIt, "copilotz-spinner");
  assertStringIncludes(button(out, "Cancel"), 'disabled=""');
  // Its close button waits too.
  assertStringIncludes(closer(out), 'disabled=""');
  assert(!out.includes('role="alert"'));
});

test("failed: its words in the dialog, as an alert, and its buttons ready to try again", () => {
  const out = html(
    <ConfirmView
      id="c"
      open
      title="Delete Ana Silva?"
      danger
      busy={false}
      error="Ana has open invoices."
      onConfirm={nothing}
      onCancel={nothing}
    />,
  );
  assertStringIncludes(out, 'role="alert"');
  assertStringIncludes(out, "Ana has open invoices.");
  assert(!button(out, "Delete").includes("disabled"));
  assert(!button(out, "Cancel").includes("disabled"));
  assert(!out.includes("aria-busy"));
});

test("a dialog kept open while busy, and one marked as a question", () => {
  const busy = html(
    <Dialog open onClose={nothing} title="Saving" busy role="alertdialog">Wait</Dialog>,
  );
  assertStringIncludes(busy, 'role="alertdialog"');
  assertStringIncludes(busy, 'aria-busy="true"');
  assertStringIncludes(closer(busy), 'disabled=""');
  const plain = html(<Dialog open onClose={nothing} title="Rename">Name</Dialog>);
  assert(!plain.includes("aria-busy") && !plain.includes("role="));
});

test("a record's dialog: its fields from data, each kind's control holding the record's value", () => {
  const out = html(
    <EntityDialog
      id="customer"
      title="Ana Silva"
      values={{
        _id: "c1",
        name: "Ana Silva",
        email: "ana@example.com",
        visits: 3,
        since: "2026-11-16",
        tier: "gold",
        vip: true,
        notes: "Prefers mornings",
      }}
      fields={[
        { name: "name", label: "Name", required: true },
        { name: "email", label: "Email", type: "email", hint: "For receipts" },
        { name: "visits", label: "Visits", type: "number", min: 0 },
        { name: "since", label: "Customer since", type: "date", format: "dd/MM/yyyy" },
        {
          name: "tier",
          label: "Tier",
          type: "select",
          options: [{ value: "gold", label: "Gold" }, { value: "silver", label: "Silver" }],
        },
        { name: "vip", label: "VIP", type: "checkbox" },
        { name: "notes", label: "Notes", type: "textarea" },
      ]}
      onSubmit={nothing}
      onClose={nothing}
    />,
  );
  assertStringIncludes(out, "copilotz-dialog-top");
  assertStringIncludes(out, '<form id="customer" class="copilotz-form');
  assertEquals(count(out, /class="copilotz-field"/g), 7);
  // Labelled, the needed one marked; each control named by the record's field.
  assertStringIncludes(out, '<span class="copilotz-field-mark" aria-hidden="true">*</span>');
  has(control(out, "name"), 'type="text"', 'required=""', 'value="Ana Silva"');
  has(control(out, "email"), 'type="email"', "aria-describedby=");
  assertStringIncludes(out, ">For receipts</p>");
  has(control(out, "visits"), 'type="number"', 'step="any"', 'min="0"', 'value="3"');
  assertStringIncludes(out, 'aria-label="Customer since: 16/11/2026"');
  assertStringIncludes(out, ">Gold</span>");
  has(control(out, "vip"), 'type="checkbox"', 'checked=""');
  assertStringIncludes(out, ">Prefers mornings</textarea>");
  assert(control(out, "notes").startsWith("<textarea"));
  // Its _id is the record's, not a field of the form.
  assertEquals(control(out, "_id"), "");
  // Cancel, and a Save that submits the form from the footer.
  assertStringIncludes(button(out, "Cancel"), 'type="button"');
  assertStringIncludes(button(out, "Save"), 'type="submit" form="customer"');
  assertStringIncludes(button(out, "Save"), "copilotz-button-primary");
});

test("a record's dialog with its fields as children: Fields, or a function of the record", () => {
  const out = html(
    <EntityDialog<{ name: string; phone: string }>
      title="New customer"
      values={{ phone: "+55 11 5555-0100" }}
      submitLabel="Add"
      placement="center"
      onSubmit={nothing}
      onClose={nothing}
    >
      {({ values, set, saving }) => (
        <>
          <Field label="Name" name="name" required>
            {(control) => <Input {...control} required />}
          </Field>
          <Field label="Phone" name="phone">
            {(control) => (
              <Input
                {...control}
                type="tel"
                value={values.phone ?? ""}
                disabled={saving}
                onChange={(e) => set({ phone: e.target.value })}
              />
            )}
          </Field>
        </>
      )}
    </EntityDialog>,
  );
  assert(!out.includes("copilotz-dialog-top"));
  has(control(out, "name"), 'required=""');
  has(control(out, "phone"), 'type="tel"', 'value="+55 11 5555-0100"');
  assertStringIncludes(button(out, "Add"), 'type="submit"');
});

test("a field with a name gives it to its control; inside a form, its refusal goes there", () => {
  const out = html(
    <Form>
      <Field label="Price" name="price" hint="In dollars">
        {(control) => <Input {...control} inputMode="decimal" />}
      </Field>
      <Field label="Code" htmlFor="code" name="code">
        <Input id="code" name="code" />
      </Field>
    </Form>,
  );
  has(control(out, "price"), "aria-describedby=", 'inputMode="decimal"');
  assertStringIncludes(out, ">In dollars</p>");
  assertEquals(count(out, /data-invalid/g), 0);
  // An error given wins, as before.
  assertStringIncludes(
    html(<Field label="Price" name="price" error="Give a price.">{(c) => <Input {...c} />}</Field>),
    'aria-invalid="true"',
  );
});
